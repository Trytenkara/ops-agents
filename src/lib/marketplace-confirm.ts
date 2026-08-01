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
const IGNORE_LINK_RE = /(unsubscribe|preferences|privacy|terms|facebook|twitter|instagram|youtube|linkedin|mailto:|\.(png|jpe?g|gif|svg|css)(\?|$))/i;

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

// Rank candidate confirmation links: a confirm-ish keyword in the URL beats a
// bare link; a link on the marketplace's own domain beats an ESP redirect.
function pickConfirmUrl(links: string[], host: string): string | null {
  const scored = links
    .filter((l) => !IGNORE_LINK_RE.test(l))
    .map((l) => {
      let score = 0;
      if (CONFIRM_LINK_RE.test(l)) score += 2;
      if (hostMatches(urlHost(l), host)) score += 1;
      return { l, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.l ?? null;
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

// Returns an InboundResult when this message WAS a marketplace confirmation
// email (handled — the caller must short-circuit), or null to continue the
// normal supplier-reply flow. Never throws.
export async function maybeConfirmMarketplaceSignup(
  admin: Admin,
  msg: InboundMessage,
  inboundOrg: { orgId: string; accountKey: string } | null
): Promise<InboundResult | null> {
  try {
    const { data: pending } = await admin
      .from("marketplace_accounts")
      .select("id, org_id, host, signup_email, status, case_id")
      .in("status", ["verifying", "signing_up"]);
    if (!pending?.length) return null;

    const fromAddr = senderAddress(msg.from);
    const fromDomain = fromAddr.split("@")[1] ?? "";
    const toEmail = msg.to_email?.trim().toLowerCase() || null;
    const links = extractLinks(msg.body_html, msg.body_text);
    const context = `${msg.subject ?? ""}\n${(msg.body_text ?? msg.body_html ?? "").slice(0, 3000)}`;
    if (!CONFIRM_CONTEXT_RE.test(context)) return null;

    const account = pending.find((a) => {
      const hostHit = hostMatches(fromDomain, a.host) || links.some((l) => hostMatches(urlHost(l), a.host));
      if (!hostHit) return false;
      if (toEmail && a.signup_email) return toEmail === a.signup_email.toLowerCase();
      if (inboundOrg) return a.org_id === inboundOrg.orgId;
      return true; // host + confirm context alone — clicking a confirm link is idempotent and safe
    });
    if (!account) return null;

    const confirmUrl = pickConfirmUrl(links, account.host);
    const now = new Date().toISOString();

    if (!confirmUrl) {
      await admin
        .from("marketplace_accounts")
        .update({ last_error: "confirmation email received but no confirm link found in body", updated_at: now })
        .eq("id", account.id);
      return { status: 200, body: { marketplace_confirm: "email_received_no_link", account_id: account.id, host: account.host } };
    }

    const click = await clickConfirmLink(confirmUrl);
    if (click.ok) {
      await admin
        .from("marketplace_accounts")
        .update({ status: "active", verified_at: now, confirm_url: confirmUrl, confirmed_via: "webhook_fetch", last_error: null, updated_at: now })
        .eq("id", account.id);
      if (account.case_id) {
        await admin.from("cases").update({ status: "resolved" }).eq("id", account.case_id);
      }
    } else {
      // Keep the link so the container-side Browserbase clicker (confirm.mjs)
      // can drive it with a real browser on the next run.
      await admin
        .from("marketplace_accounts")
        .update({ confirm_url: confirmUrl, last_error: `confirm fetch failed: ${click.detail}`, updated_at: now })
        .eq("id", account.id);
    }

    await admin.from("audit_log").insert({
      action: "marketplace_signup_confirm",
      target_table: "marketplace_accounts",
      target_id: account.id,
      diff: { host: account.host, clicked: click.ok, click_detail: click.detail, from: fromAddr },
    });

    return {
      status: 200,
      body: { marketplace_confirm: click.ok ? "activated" : "click_failed_link_stored", account_id: account.id, host: account.host, detail: click.detail },
    };
  } catch (e: any) {
    // Never let confirmation handling break the supplier-reply loop.
    console.error("marketplace-confirm error:", e?.message ?? e);
    return null;
  }
}
