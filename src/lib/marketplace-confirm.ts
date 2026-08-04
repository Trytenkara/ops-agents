import type { createAdminClient } from "@/lib/supabase/admin";
import type { InboundMessage, InboundResult } from "@/lib/tenkara-inbound";

type Admin = ReturnType<typeof createAdminClient>;

// Marketplace signups (provision.mjs, container-side) register with the org's
// Tenkara-managed address, so the "confirm your email" message arrives HERE via
// the message.received webhook — the one channel where we hold the full body.
// Detect it before reply-matching (it is not a supplier reply), extract the
// confirmation link, click it server-side, and flip the marketplace account
// active. This closes the signup loop with no human click.

const CONFIRM_CONTEXT_RE = /(confirm|verif|activat|validate your|complete (your )?(registration|sign ?up|account)|welcome)/i;
const CONFIRM_LINK_RE = /(confirm|verif|activat|validate|token=|registration|account\/enable|welcome)/i;
const IGNORE_LINK_RE = /(privacy|terms|facebook|twitter|instagram|youtube|linkedin|mailto:|\.(png|jpe?g|gif|svg|css)(\?|$))/i;

// A GET on one of these logs us out of a live client account instead of into it,
// so they are never fetchable regardless of how confirm-ish the surrounding mail
// looks. Tenkara strips these upstream too; this is the second line of defence
// because the message.received path sees raw bodies Tenkara never filtered.
const DESTRUCTIVE_LINK_RE = /(unsubscribe|opt[-_]?out|optout|remove[-_]?me|delete[-_]?account|deactivate|close[-_]?account|cancel[-_]?account|manage[-_]?preferences|email[-_]?preferences|preference[-_]?cent)/i;

// Accounts a verification link may legitimately activate. `failed` is included
// because the signup driver gives up on gates it cannot see past (approval
// queues, OTP walls) — a confirmation mail arriving afterwards means the
// registration did land, and that row is exactly the one to revive.
const ELIGIBLE_STATUSES = ["verifying", "signing_up", "failed"];

function bareHost(h: string | null | undefined): string {
  return (h ?? "").toLowerCase().replace(/^www\./, "");
}

// mail.bulkfoods.com matches bulkfoods.com (and vice versa), with dot boundaries.
function hostMatches(a: string, b: string): boolean {
  const x = bareHost(a);
  const y = bareHost(b);
  if (!x || !y) return false;
  return x === y || x.endsWith("." + y) || y.endsWith("." + x);
}

function senderAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

function extractLinks(bodyHtml: string | null | undefined, bodyText: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of (bodyHtml ?? "").matchAll(/href=["']?(https?:\/\/[^"'\s>]+)/gi)) out.add(m[1]);
  for (const m of (bodyText ?? "").matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) out.add(m[0]);
  return [...out];
}

function urlHost(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

// Block SSRF targets: literal IPs and internal-only names never appear in a real
// marketplace confirmation link, but they are what an attacker-supplied one uses
// to make our server probe the private network it runs in.
function isUnfetchableHost(u: string): boolean {
  const host = bareHost(urlHost(u));
  if (!host) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[")) return true;
  return /(^|\.)(localhost|local|internal|intranet|home|lan)$/.test(host) || !host.includes(".");
}

// Rank candidate confirmation links. A link on the marketplace's own domain
// always beats one on a third-party domain: the previous scoring let a
// confirm-ish keyword outrank the host match, so a link like
// https://attacker.example/x?token=1 (score 2) beat the real
// https://marketplace.com/welcome (score 1) in the same email.
function pickConfirmUrl(links: string[], host: string): { url: string; sameHost: boolean } | null {
  const usable = links.filter(
    (l) => /^https?:\/\//i.test(l) && !IGNORE_LINK_RE.test(l) && !DESTRUCTIVE_LINK_RE.test(l) && !isUnfetchableHost(l)
  );
  const onHost = usable.filter((l) => hostMatches(urlHost(l), host));
  const best = onHost.find((l) => CONFIRM_LINK_RE.test(l)) ?? onHost[0];
  if (best) return { url: best, sameHost: true };
  // Nothing on the marketplace's own domain — most likely an ESP click-tracker,
  // but a spoofed From is enough to fake everything else about the mail, so this
  // is recorded for the Browserbase clicker rather than fetched.
  const offHost = usable.find((l) => CONFIRM_LINK_RE.test(l));
  return offHost ? { url: offHost, sameHost: false } : null;
}

async function clickConfirmLink(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(15000),
    });
    // Confirmation endpoints consume the token on the GET itself; any non-error
    // response means the click landed even if the page finishes rendering in JS.
    return { ok: res.status < 400, detail: `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 200) };
  }
}

interface ConfirmSignal {
  from: string;
  toEmail: string | null;
  links: string[];
  orgId: string | null;
  source: "message_received" | "verification_link_event";
}

// Match a verification mail to the account it belongs to and, if it can be
// trusted, click through. Trust needs BOTH of:
//   1. the sender domain IS the marketplace we registered with, and
//   2. the recipient is that account's signup address (or resolves to its org).
// The old code fell back to "host appeared somewhere in the mail" with no
// recipient check, so any sender who learned an outreach address could steer a
// server-side GET by naming a pending marketplace host in the body.
async function confirmFromSignal(admin: Admin, sig: ConfirmSignal): Promise<InboundResult | null> {
  const { data: pending } = await admin
    .from("marketplace_accounts")
    .select("id, org_id, host, signup_email, status, case_id")
    .in("status", ELIGIBLE_STATUSES);
  if (!pending?.length) return null;

  const fromAddr = senderAddress(sig.from);
  const fromDomain = fromAddr.split("@")[1] ?? "";
  if (!fromDomain) return null;

  const account = pending.find((a) => {
    if (!hostMatches(fromDomain, a.host)) return false;
    if (sig.toEmail && a.signup_email) return sig.toEmail === a.signup_email.toLowerCase();
    if (sig.orgId) return a.org_id === sig.orgId;
    return false;
  });
  if (!account) return null;

  const picked = pickConfirmUrl(sig.links, account.host);
  const now = new Date().toISOString();

  if (!picked) {
    await admin
      .from("marketplace_accounts")
      .update({ last_error: "verification email received but no fetchable confirm link found", updated_at: now })
      .eq("id", account.id);
    return { status: 200, body: { marketplace_confirm: "email_received_no_link", account_id: account.id, host: account.host } };
  }

  // Only ever auto-open a URL on a domain we actually registered an account
  // with. Anything else is stored for the container-side Browserbase clicker,
  // which runs against a real browser under operator-visible state.
  if (!picked.sameHost) {
    await admin
      .from("marketplace_accounts")
      .update({
        confirm_url: picked.url,
        last_error: `confirm link is off-domain (${urlHost(picked.url)}); not auto-opened, queued for browser confirm`,
        updated_at: now,
      })
      .eq("id", account.id);
    return {
      status: 200,
      body: { marketplace_confirm: "off_domain_link_stored", account_id: account.id, host: account.host, url_host: urlHost(picked.url) },
    };
  }

  const click = await clickConfirmLink(picked.url);
  if (click.ok) {
    await admin
      .from("marketplace_accounts")
      .update({ status: "active", verified_at: now, confirm_url: picked.url, confirmed_via: "webhook_fetch", last_error: null, updated_at: now })
      .eq("id", account.id);
    if (account.case_id) {
      await admin.from("cases").update({ status: "resolved" }).eq("id", account.case_id);
    }
  } else {
    // Keep the link so the container-side Browserbase clicker (confirm.mjs)
    // can drive it with a real browser on the next run.
    await admin
      .from("marketplace_accounts")
      .update({ confirm_url: picked.url, last_error: `confirm fetch failed: ${click.detail}`, updated_at: now })
      .eq("id", account.id);
  }

  await admin.from("audit_log").insert({
    action: "marketplace_signup_confirm",
    target_table: "marketplace_accounts",
    target_id: account.id,
    diff: {
      host: account.host,
      clicked: click.ok,
      click_detail: click.detail,
      from: fromAddr,
      source: sig.source,
      url_host: urlHost(picked.url),
      prior_status: account.status,
    },
  });

  return {
    status: 200,
    body: { marketplace_confirm: click.ok ? "activated" : "click_failed_link_stored", account_id: account.id, host: account.host, detail: click.detail },
  };
}

// Returns an InboundResult when this message WAS a marketplace confirmation
// email (handled — the caller must short-circuit), or null to continue the
// normal supplier-reply flow. Never throws.
export async function maybeConfirmMarketplaceSignup(
  admin: Admin,
  msg: InboundMessage,
  inboundOrg: { orgId: string; accountKey: string } | null
): Promise<InboundResult | null> {
  try {
    const context = `${msg.subject ?? ""}\n${(msg.body_text ?? msg.body_html ?? "").slice(0, 3000)}`;
    if (!CONFIRM_CONTEXT_RE.test(context)) return null;
    return await confirmFromSignal(admin, {
      from: msg.from,
      toEmail: msg.to_email?.trim().toLowerCase() || null,
      links: extractLinks(msg.body_html, msg.body_text),
      orgId: inboundOrg?.orgId ?? null,
      source: "message_received",
    });
  } catch (e: any) {
    // Never let confirmation handling break the supplier-reply loop.
    console.error("marketplace-confirm error:", e?.message ?? e);
    return null;
  }
}

// Tenkara's `verification_link.detected` event: it runs the detection and link
// extraction on its side and sends us only the URLs, so there is no body to scan
// and no risk of this being mistaken for a supplier reply. The trust checks in
// confirmFromSignal still apply — Tenkara vouches that the mail looked like a
// verification, not that the sender is who they claim to be.
export interface VerificationLinkEvent {
  to_email?: string | null;
  from_email?: string | null;
  from?: string | null;
  subject?: string | null;
  links?: string[] | null;
  conversation_id?: string | null;
  message_id?: string | null;
}

export async function handleVerificationLinkDetected(admin: Admin, evt: VerificationLinkEvent): Promise<InboundResult> {
  const from = (evt.from_email ?? evt.from ?? "").trim();
  const links = (evt.links ?? []).filter((l) => typeof l === "string" && l.trim().length > 0);
  if (!from || !links.length) {
    return { status: 200, body: { marketplace_confirm: "ignored_incomplete_event" } };
  }
  try {
    const result = await confirmFromSignal(admin, {
      from,
      toEmail: evt.to_email?.trim().toLowerCase() || null,
      links,
      orgId: null,
      source: "verification_link_event",
    });
    return result ?? { status: 200, body: { marketplace_confirm: "no_matching_account" } };
  } catch (e: any) {
    console.error("verification-link-detected error:", e?.message ?? e);
    return { status: 200, body: { marketplace_confirm: "error", detail: String(e?.message ?? e).slice(0, 200) } };
  }
}
