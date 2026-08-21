import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { cappedRead } from "@/lib/capped-read";
import { getOrgAssignmentContext, spreadOwnerId, orgAutoKey, type AssignmentContext } from "@/lib/operator-assignment";
import { classifyClient } from "../quote-revalidation/config";
import { loadOrgStatuses, outreachAllowed } from "@/lib/org-status";
import { runOutreachForSupplier, type OutreachLead } from "../outreach/run-outreach";
import { isAggregatorDomain } from "../data-enrichment/enrich";
import { stageDraft } from "@/lib/draft-staging";
import { tenkaraEmailAccountIdFor } from "@/lib/tenkara";
import { randomUUID } from "crypto";
import { isRetiredContact } from "@/lib/contact-change";

// Agent 22 — Operator-injected email outreach.
//
// When an operator hand-adds a supplier email in the Control Room, that address
// is a human judgement: someone went and found the person who can quote this
// material. Agent 04 was silently discarding a large share of them, because its
// first-contact path is built around "one cold thread per supplier, never a
// second". Three of its suppressions are wrong for a hand-added address:
//
//  1. Supplier already has a thread → Agent 04 holds the material for the reply
//     loop and the new person is never written to. Here we CC them onto the
//     existing thread instead, which is the whole point of adding them.
//  2. Another company shares the mailbox domain (the 126.com / qq.com / foxmail
//     case) → Agent 04's domain-wide "already contacted" fallback collapsed 16
//     distinct Cal Chem suppliers onto five consumer mailboxes. This agent
//     matches on the EXACT address only.
//  3. The duplicate-record question is unresolved → the material inquiry died
//     with the parked record. Here the inquiry goes out and the record question
//     stays parked exactly as it was; nothing about duplicate_review is cleared.
//
// Everything staged is a DRAFT for operator review, same as the rest of cold
// outbound. Record creation is never unparked by this agent.

type Admin = ReturnType<typeof createAdminClient>;

const MAX_LEADS_PER_RUN = 120;
const LIVE_THREAD_STATUSES = ["staged", "reviewed", "sent", "linked"];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Plain-text note that brings a newly-found contact onto a thread that is
// already open with their company. Deliberately deterministic (no model call):
// it is three sentences and a question, and a template cannot drift into
// inventing a grade or a price.
function buildIntroductionBody(input: {
  contactName: string | null;
  supplierName: string | null;
  materialName: string | null;
  signoff: string;
}): string {
  const greeting = input.contactName ? `Hi ${input.contactName},` : "Hello,";
  const material = input.materialName ?? "the material below";
  return [
    greeting,
    "",
    `Adding you to this thread as the right contact for ${material} at ${input.supplierName ?? "your company"}.`,
    "",
    `Could you share your current pricing and minimum order quantity for ${material}, along with lead time and the grades you supply?`,
    "",
    "Happy to send over volumes and destination details once we know what you can offer.",
    "",
    "Best regards,",
    input.signoff,
  ].join("\n");
}

registerAgent({
  slug: "agent-22-operator-email-outreach",
  displayName: "Agent 22 - Operator Email Outreach",
  description:
    "Drafts a sourcing inquiry for every supplier email an operator hand-added. Matches an already-contacted supplier on the exact address only (never a shared mailbox domain), CCs the new contact onto a live thread rather than discarding them, and leaves any duplicate-record park untouched.",
  async run(ctx) {
    const admin = createAdminClient();

    const orgStatuses = await loadOrgStatuses(admin);
    let activeOrgIds = Array.from(orgStatuses.byOaId.entries())
      .filter(([, s]) => outreachAllowed(s))
      .map(([id]) => id);

    // Manual trigger can scope the run to one client (?slug=…&org_slug=…), used
    // to drain a single client's backlog under supervision before the hourly
    // schedule takes the rest.
    const onlyOrgSlug = typeof ctx.input?.org_slug === "string" ? ctx.input.org_slug : null;
    if (onlyOrgSlug) {
      const { data: only } = await admin.from("orgs").select("id").eq("slug", onlyOrgSlug).maybeSingle();
      activeOrgIds = only && activeOrgIds.includes(only.id) ? [only.id] : [];
    }
    if (!activeOrgIds.length) {
      ctx.setSummary("No orgs are open for outreach.");
      ctx.setStatus("success");
      return;
    }

    // Every active lead carrying a hand-added address that this agent has not
    // already acted on. Stage is deliberately NOT filtered: a lead parked in
    // ready_for_approval for a duplicate-record question still needs its
    // material asked about. ready_for_outreach is excluded because a draft for
    // it already exists.
    // PERS-06: the run already says when the TIME budget bit, but said nothing
    // when the 120-lead cap did, so a queue deeper than one run looked drained.
    const leadRead = await cappedRead<any>(
      admin
        .from("leads_in_flight")
        .select(
          "id, org_id, supplier_id, supplier_name, material_id, material_name, stage, confidence_score, assigned_operator_id, assigned_operator_at, payload",
          { count: "exact" }
        )
        .eq("status", "active")
        .in("org_id", activeOrgIds)
        .neq("stage", "ready_for_outreach")
        .eq("payload->>contact_source", "manual_operator")
        .is("payload->operator_email_outreach", null)
        .order("created_at", { ascending: true })
        .limit(MAX_LEADS_PER_RUN),
      MAX_LEADS_PER_RUN,
      "operator-added emails awaiting an inquiry"
    );

    const leads = leadRead.rows;
    if (!leads.length) {
      ctx.setSummary("No operator-added emails are waiting on an inquiry.");
      ctx.setStatus("success");
      return;
    }

    const orgIds = Array.from(new Set(leads.map((l) => l.org_id).filter(Boolean) as string[]));
    const orgsById = new Map<string, any>();
    {
      const { data: orgRows } = await admin
        .from("orgs")
        .select("id, name, tenkara_email_account_id, subject_prefix")
        .in("id", orgIds);
      for (const r of (orgRows ?? []) as any[]) orgsById.set(r.id, r);
    }
    const assignmentCtxByOrg = new Map<string, AssignmentContext>();
    for (const oid of orgIds) assignmentCtxByOrg.set(oid, await getOrgAssignmentContext(admin, oid));

    let ccdOntoThread = 0;
    let coldStaged = 0;
    let alreadyReached = 0;
    let skipped = 0;
    let errors = 0;

    // Each draft costs a model call plus a round trip to the inbox, so a full
    // backlog does not fit in one invocation. Stop short of the platform's own
    // limit and finish cleanly: a timed-out run reports nothing at all, and the
    // next run picks up exactly where this one stopped (leads are stamped as
    // they are handled, and the fetch skips stamped ones).
    const deadline = Date.now() + 11 * 60 * 1000;
    let ranOutOfTime = 0;

    for (const lead of leads) {
      if (Date.now() > deadline) {
        ranOutOfTime++;
        continue;
      }
      const payload = (lead.payload ?? {}) as any;
      const email = String(payload.supplier_contact_email ?? "").trim().toLowerCase();
      const org = orgsById.get(lead.org_id);
      // An address an operator replaced, or one that bounced, is not an address
      // to reach out on, even if it is still sitting on the row somewhere.
      if (isRetiredContact(payload, email)) {
        skipped++;
        await stamp(admin, lead.id, payload, { action: "skipped", reason: "retired_email", runId: ctx.runId });
        continue;
      }
      if (!org || !EMAIL_RE.test(email)) {
        skipped++;
        await stamp(admin, lead.id, payload, { action: "skipped", reason: org ? "invalid_email" : "unmapped_org", runId: ctx.runId });
        continue;
      }

      // An address on a marketplace's own domain reaches the platform, not the
      // supplier. Those go through the marketplace inquiry path, not a cold
      // email to a person, so leave them for that flow rather than burning the
      // address here.
      const emailDomain = email.split("@")[1] ?? "";
      if (isAggregatorDomain(emailDomain)) {
        skipped++;
        await stamp(admin, lead.id, payload, { action: "skipped", reason: "marketplace_mailbox", runId: ctx.runId });
        continue;
      }

      const configuredInboxId = org.tenkara_email_account_id ?? null;
      const cls = configuredInboxId ? { mode: "active" as const, ghostBrand: undefined } : classifyClient(org.name);
      if (cls.mode === "skip") {
        skipped++;
        await stamp(admin, lead.id, payload, { action: "skipped", reason: "brand_not_mapped", runId: ctx.runId });
        continue;
      }

      const actx = assignmentCtxByOrg.get(lead.org_id);
      const assignedOperator =
        lead.assigned_operator_id ??
        (actx
          ? spreadOwnerId(
              actx,
              orgAutoKey(actx, { supplierId: lead.supplier_id, supplierName: lead.supplier_name, email, leadId: lead.id }),
              { nameHint: lead.supplier_name }
            )
          : null);

      try {
        // EXACT address only. A shared consumer mailbox domain says nothing
        // about whether this company has been written to, and treating it as
        // proof is what suppressed sixteen distinct suppliers.
        const { data: alias } = await admin
          .from("supplier_email_aliases")
          .select("id, thread_id, draft_ref_id")
          .eq("org_id", lead.org_id)
          .eq("email", email)
          .maybeSingle();
        if (alias?.thread_id) {
          alreadyReached++;
          await stamp(admin, lead.id, payload, { action: "already_on_thread", thread_id: alias.thread_id, runId: ctx.runId });
          continue;
        }

        // Does this supplier already have a live thread? Only a supplier_id
        // match counts here. No email-domain fallback.
        let liveThread: any = null;
        if (lead.supplier_id) {
          const { data } = await admin
            .from("draft_references")
            .select("id, thread_id, subject, org_id, supplier_id, material_id, assigned_operator, metadata, email_client, status")
            .eq("org_id", lead.org_id)
            .eq("supplier_id", lead.supplier_id)
            .in("status", LIVE_THREAD_STATUSES)
            .eq("email_client", "rod_app")
            .not("thread_id", "is", null)
            .order("created_at", { ascending: false })
            .limit(1);
          liveThread = (data ?? [])[0] ?? null;
        }

        const reservationId = randomUUID();
        const { data: reserved, error: reserveErr } = await admin.rpc("reserve_supplier_emails", {
          p_org_id: lead.org_id,
          p_emails: [email],
          p_reservation_id: reservationId,
        });
        if (reserveErr || reserved !== true) {
          await admin.rpc("release_supplier_email_reservation", { p_org_id: lead.org_id, p_reservation_id: reservationId });
          alreadyReached++;
          await stamp(admin, lead.id, payload, { action: "already_reserved", runId: ctx.runId });
          continue;
        }

        if (liveThread) {
          // CC the hand-added person onto the open thread. There is no API to
          // edit a live conversation's recipients, so this is a new reply draft
          // on the same conversation with them CC'd, which is the same shape
          // Agent 15 uses for its follow-up CCs.
          const meta = (liveThread.metadata ?? {}) as any;
          const toAddress = String(meta.supplier_contact_email ?? "").trim().toLowerCase();
          if (!toAddress || toAddress === email) {
            await admin.rpc("release_supplier_email_reservation", { p_org_id: lead.org_id, p_reservation_id: reservationId });
            skipped++;
            await stamp(admin, lead.id, payload, { action: "skipped", reason: "thread_has_no_recipient", runId: ctx.runId });
            continue;
          }
          const signoff = meta.suggested_signoff ?? meta.ghost_brand ?? `${org.name} Purchasing Team`;
          const staged = await stageDraft({
            admin,
            agentId: ctx.agentId,
            runId: ctx.runId,
            orgId: lead.org_id,
            supplierId: lead.supplier_id,
            materialId: lead.material_id,
            to: { name: meta.supplier_contact_name ?? null, address: toAddress },
            cc: [{ name: (payload.enrichment?.contact?.name as string | null) ?? null, address: email }],
            subject: (liveThread.subject ?? "").startsWith("Re:") ? liveThread.subject : `Re: ${liveThread.subject ?? "sourcing inquiry"}`,
            body: buildIntroductionBody({
              contactName: (payload.enrichment?.contact?.name as string | null) ?? null,
              supplierName: lead.supplier_name,
              materialName: lead.material_name,
              signoff,
            }),
            assignedOperator: liveThread.assigned_operator ?? assignedOperator,
            conversationId: liveThread.thread_id,
            metadata: {
              outreach_mode: meta.outreach_mode ?? cls.mode,
              ghost_brand: meta.ghost_brand ?? cls.ghostBrand ?? null,
              supplier_name: lead.supplier_name,
              supplier_contact_email: toAddress,
              cc_contacts: [email],
              lead_id: lead.id,
              material_id: lead.material_id,
              material_name: lead.material_name,
              draft_kind: "operator_contact_introduction",
              staged_via: "agent-22-operator-email-outreach",
              // Who hand-added the address, so an operator reviewing this draft
              // can see whose call it was.
              operator_email_added_by: payload.manual_email_added_by ?? null,
              operator_email_added_at: payload.manual_email_added_at ?? null,
            },
          });
          if (!staged.ok) {
            await admin.rpc("release_supplier_email_reservation", { p_org_id: lead.org_id, p_reservation_id: reservationId });
            errors++;
            await ctx.log(`CC-onto-thread failed for ${email}: ${staged.error}`, { level: "warn", step: "cc_thread" });
            continue;
          }
          await admin
            .from("supplier_email_aliases")
            .update({
              thread_id: liveThread.thread_id,
              draft_ref_id: staged.draftRefId ?? liveThread.id,
              supplier_id: lead.supplier_id,
              supplier_name: lead.supplier_name,
              claim_status: "attached",
              reservation_id: null,
            })
            .eq("reservation_id", reservationId)
            .eq("claim_status", "reserved");
          ccdOntoThread++;
          await stamp(admin, lead.id, payload, {
            action: "ccd_onto_thread",
            thread_id: liveThread.thread_id,
            draft_ref_id: staged.draftRefId ?? null,
            runId: ctx.runId,
          });
          await ctx.log(`CC'd ${email} onto the open thread with ${lead.supplier_name ?? "supplier"} for ${lead.material_name ?? "material"}`, {
            step: "cc_thread",
          });
          continue;
        }

        // No live thread: ordinary first contact for this one material.
        const res = await runOutreachForSupplier({
          admin,
          agentId: ctx.agentId,
          runId: ctx.runId,
          orgId: lead.org_id,
          supplierId: lead.supplier_id,
          supplierName: lead.supplier_name,
          email,
          contactName: (payload.enrichment?.contact?.name as string | null) ?? null,
          mode: cls.mode,
          ghostBrand: cls.ghostBrand,
          clientOrgName: org.name,
          emailAccountId: configuredInboxId,
          assignedOperator,
          isMarketplace: false,
          orgSubjectPrefix: org.subject_prefix ?? null,
          leads: [lead as OutreachLead],
          log: (m, meta2) => ctx.log(m, meta2),
        });
        if (!res.staged) {
          await admin.rpc("release_supplier_email_reservation", { p_org_id: lead.org_id, p_reservation_id: reservationId });
          errors++;
          continue;
        }
        await admin
          .from("supplier_email_aliases")
          .update({
            thread_id: res.conversationId ?? null,
            draft_ref_id: res.draftRefId ?? null,
            supplier_id: lead.supplier_id,
            supplier_name: lead.supplier_name,
            claim_status: "attached",
            reservation_id: null,
          })
          .eq("reservation_id", reservationId)
          .eq("claim_status", "reserved");
        coldStaged++;
        // runOutreachForSupplier already rewrote the payload (stage is now
        // ready_for_outreach), so re-read before stamping or the stamp would
        // clobber the outreach block it just wrote. duplicate_review and any
        // other park marker survive that rewrite untouched, which is what keeps
        // the record question parked while the inquiry goes out.
        const { data: fresh } = await admin.from("leads_in_flight").select("payload").eq("id", lead.id).maybeSingle();
        await stamp(admin, lead.id, ((fresh?.payload ?? payload) as any), {
          action: "cold_first_contact",
          draft_ref_id: res.draftRefId ?? null,
          runId: ctx.runId,
        });
      } catch (e: any) {
        errors++;
        await ctx.log(`Operator-email outreach failed for lead ${lead.id}: ${e?.message ?? e}`, { level: "error", step: "outreach" });
      }
    }

    ctx.setItemsProcessed(ccdOntoThread + coldStaged);
    ctx.setStatus(errors > 0 && ccdOntoThread + coldStaged === 0 ? "failure" : errors > 0 ? "partial" : "success");
    ctx.setSummary(
      `Operator-added emails: ${coldStaged} first-contact draft${coldStaged === 1 ? "" : "s"} · ${ccdOntoThread} CC'd onto an open thread · ${alreadyReached} already reached · ${skipped} skipped${errors ? ` · ${errors} errors` : ""}${ranOutOfTime ? ` · ${ranOutOfTime} left for the next run (time budget)` : ""}${leadRead.remainder ? ` · ${leadRead.remainder} more waiting (batch cap)` : ""}`
    );
  },
});

async function stamp(admin: Admin, leadId: string, payload: any, result: Record<string, any>) {
  await admin
    .from("leads_in_flight")
    .update({
      payload: {
        ...(payload ?? {}),
        operator_email_outreach: { ...result, at: new Date().toISOString() },
      },
    })
    .eq("id", leadId);
}
