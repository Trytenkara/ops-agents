import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAllPaged } from "@/lib/supabase-paging";
import { postAgentAlert } from "@/lib/slack-alert";
import { orgScopedKey } from "@/lib/org-isolation";

// Agent 23 - Org Isolation Audit.
//
// The detection half of org isolation. `src/lib/org-isolation.ts` and the
// check-rules entries stop the mistakes we have already seen; this looks at what
// actually landed in the data and says so when a client's name shows up where it
// should not.
//
// It exists because the July/August contamination ran for three weeks without
// anyone noticing: 67 conversations shared between two clients, 136 drafts, and
// the only reason it surfaced at all was an operator recognising the wrong brand
// on a draft. Every check below would have fired on day one.
//
// Read-only. It never repairs anything: a cross-client record needs a human
// decision about whose it is, and a repair loop that guesses would hide the
// fault it is supposed to report.

const FEEDBACK_CHANNEL = () => process.env.SLACK_FEEDBACK_CHANNEL_ID ?? "C0BATUWBHC7";
// Older material is history, not news. The contamination we cleaned on
// 2026-08-18 must not re-alert every night.
const LOOKBACK_DAYS = 14;
const SAMPLE = 5;

interface Finding {
  check: string;
  count: number;
  detail: string;
  sample: string[];
}

registerAgent({
  slug: "agent-23-org-isolation-audit",
  displayName: "Agent 23 - Org Isolation Audit",
  description:
    "Nightly read-only sweep for one client's data appearing under another client's name: shared conversations, shared drafts, colliding reference numbers, replies parked with no client, and draft copy naming the wrong client. Reports, never repairs.",
  async run(ctx) {
    const admin = createAdminClient();
    const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
    const findings: Finding[] = [];

    const { data: orgRows } = await admin.from("orgs").select("id, name");
    const orgName = new Map<string, string>((orgRows ?? []).map((o: any) => [o.id, o.name]));
    const { data: brandRows } = await admin.from("client_settings").select("org_id, ghost_brand");
    // The brand an operator actually sees on the draft. A body naming a client
    // is only wrong if it names a DIFFERENT client than the one it is filed
    // under, so both the real name and the ghost brand belong in this map.
    const brandsByOrg = new Map<string, string[]>();
    for (const [id, name] of orgName) brandsByOrg.set(id, [name]);
    for (const b of (brandRows ?? []) as any[]) {
      if (!b.ghost_brand) continue;
      brandsByOrg.set(b.org_id, [...(brandsByOrg.get(b.org_id) ?? []), b.ghost_brand]);
    }

    const refs = await selectAllPaged<any>((from, to) =>
      admin
        .from("draft_references")
        .select("id, org_id, thread_id, draft_id, supplier_id, status, subject, body_preview, metadata, created_at")
        .eq("email_client", "rod_app")
        // A discarded draft is a record of something we already dealt with (the
        // 2026-08-18 cleanup discarded 136 of them). Auditing it would report
        // the same fault every night and train everyone to ignore the alert.
        .neq("status", "discarded")
        .gte("created_at", since)
        .order("id")
        .range(from, to)
    );
    await ctx.log(`${refs.length} draft reference(s) in the last ${LOOKBACK_DAYS}d`, { step: "load" });

    // 1 + 2. Two clients on one conversation, or holding one physical draft.
    // This is the original fault: Tenkara handed the second client the first
    // client's thread, so an operator reviewing California Chemicals' inquiry
    // saw it under the Sierra Materials brand.
    const byThread = new Map<string, Set<string>>();
    const byDraft = new Map<string, Set<string>>();
    const byExternalId = new Map<string, Set<string>>();
    for (const r of refs) {
      const org = r.org_id ?? "none";
      if (r.thread_id) byThread.set(r.thread_id, (byThread.get(r.thread_id) ?? new Set()).add(org));
      if (r.draft_id) byDraft.set(r.draft_id, (byDraft.get(r.draft_id) ?? new Set()).add(org));
      const ext = r.metadata?.external_id;
      if (ext) byExternalId.set(ext, (byExternalId.get(ext) ?? new Set()).add(org));
    }
    const multi = (m: Map<string, Set<string>>) => [...m.entries()].filter(([, s]) => s.size > 1);

    for (const [check, m, detail] of [
      ["shared_conversation", byThread, "conversation(s) carry drafts from more than one client"],
      ["shared_draft", byDraft, "physical draft(s) are owned by more than one client"],
      ["colliding_external_id", byExternalId, "reference key(s) are in use by more than one client"],
    ] as [string, Map<string, Set<string>>, string][]) {
      const bad = multi(m);
      if (bad.length) {
        findings.push({
          check,
          count: bad.length,
          detail,
          sample: bad.slice(0, SAMPLE).map(
            ([k, orgs]) => `${k} (${[...orgs].map((o) => orgName.get(o) ?? o).join(" + ")})`
          ),
        });
      }
    }

    // 3. Draft copy naming a client that is not the one it belongs to. Catches
    // the failure the key-level checks cannot see: right conversation, wrong
    // company written into the body.
    const wrongBrand: string[] = [];
    for (const r of refs) {
      const text = `${r.subject ?? ""} ${r.body_preview ?? ""}`;
      if (!text.trim()) continue;
      const own = new Set((brandsByOrg.get(r.org_id) ?? []).map((b) => b.toLowerCase()));
      for (const [otherOrg, brands] of brandsByOrg) {
        if (otherOrg === r.org_id) continue;
        for (const brand of brands) {
          // Short brand strings ("Rod") would match inside ordinary words.
          if (brand.length < 6) continue;
          if (own.has(brand.toLowerCase())) continue;
          if (!text.toLowerCase().includes(brand.toLowerCase())) continue;
          wrongBrand.push(`${r.id} filed under ${orgName.get(r.org_id) ?? r.org_id} names "${brand}"`);
        }
      }
    }
    if (wrongBrand.length) {
      findings.push({
        check: "draft_names_another_client",
        count: wrongBrand.length,
        detail: "draft(s) name a client other than the one they are filed under",
        sample: wrongBrand.slice(0, SAMPLE),
      });
    }

    // 4. Supplier replies we could not attribute. Since the inbound matcher now
    // refuses an ambiguous match rather than guessing, these park instead of
    // being misfiled — which is correct, and worthless if nobody works them.
    const { data: orphans } = await admin
      .from("unmatched_inbound_events")
      .select("id, conversation_id, sender_email, created_at")
      .is("org_id", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false });
    if (orphans?.length) {
      findings.push({
        check: "reply_with_no_client",
        count: orphans.length,
        detail: "supplier repl(ies) could not be attributed to a client and are waiting in triage",
        sample: (orphans as any[]).slice(0, SAMPLE).map((o) => `${o.sender_email} (${o.created_at.slice(0, 10)})`),
      });
    }

    // 5. One supplier being written to by two clients is normal and expected.
    // It is only worth reporting alongside the checks above, as the population
    // those faults come from, so it is logged and never alerted on.
    const supplierOrgs = new Map<string, Set<string>>();
    for (const r of refs) {
      const sid = r.supplier_id ?? r.metadata?.supplier_id ?? null;
      if (!sid) continue;
      supplierOrgs.set(sid, (supplierOrgs.get(sid) ?? new Set()).add(orgScopedKey(r.org_id)));
    }
    const shared = [...supplierOrgs.values()].filter((s) => s.size > 1).length;
    await ctx.log(`${shared} supplier(s) worked by more than one client (expected, not a fault)`, { step: "context" });

    ctx.setItemsProcessed(refs.length);

    if (!findings.length) {
      ctx.setStatus("success");
      ctx.setSummary(`Clean: no cross-client records in the last ${LOOKBACK_DAYS} days (${refs.length} drafts checked).`);
      return;
    }

    for (const f of findings) {
      await ctx.log(`${f.check}: ${f.count} ${f.detail}`, {
        level: "warn",
        step: "finding",
        data: { check: f.check, count: f.count, sample: f.sample },
      });
    }

    const lines = findings.map((f) => `• *${f.count}* ${f.detail}\n   ${f.sample.join("\n   ")}`);
    await postAgentAlert(
      `:rotating_light: *Cross-client data found* (last ${LOOKBACK_DAYS}d)\n${lines.join("\n")}\n` +
        `Nothing was changed automatically: each of these needs a human to say whose it is.`,
      {
        channel: FEEDBACK_CHANNEL(),
        severity: "p1",
        title: "Org isolation audit",
        key: `org_isolation_audit:${findings.map((f) => `${f.check}=${f.count}`).join(",")}`,
        ttlMinutes: 60 * 20,
      }
    );

    ctx.setStatus("partial");
    ctx.setSummary(
      `${findings.reduce((n, f) => n + f.count, 0)} cross-client record(s) across ${findings.length} check(s): ` +
        findings.map((f) => `${f.check} ${f.count}`).join(", ")
    );
  },
});
