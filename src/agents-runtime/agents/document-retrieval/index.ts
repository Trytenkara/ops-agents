import crypto from "crypto";
import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadOrgStatuses, sourcingAllowed } from "@/lib/org-status";
import { retrieveDocumentsFromUrl } from "@/lib/document-retrieve";
import { syncDocRequirementsMet } from "@/lib/document-requirements";
import { orgScopedKey } from "@/lib/org-isolation";
import { advanceDryPass, retryAfter } from "@/lib/dry-pass";

// Agent 09 - Document Retrieval.
//
// Collects supplier qualification documents (SDS, CoA, TDS, certificates) that
// are published on a product or supplier page rather than emailed to us. The
// email half of this already works: Agent 15 asks for documents and inbound
// attachments land on the bench. This closes the other half, which matters
// because a document already sitting on a public page costs nothing to ask for.
//
// Deliberately NOT folded into Agent 05's price pull, even though 05 is already
// on these pages. A doc pass means several PDF downloads plus a Claude
// extraction per lead, and 05 is close enough to its ceiling that adding that
// would trade priced leads for documents. Separate agent, separate budget, and
// it can cover suppliers we never price-pulled.
//
// Measured on 80 real California Chemicals pages: 39% of reachable pages expose
// documents directly, 56 candidate files. A second hop to a "Safety Data Sheets"
// or "Documents" tab was tried and rescued 1 page in 41 (and that one was a
// company certifications page, not product documents), so there is no hub hop.
// The real ceiling is bot-blocking: 10 of 80 pages returned 403 or 429, which is
// what a browser escalation would have to solve.

const MAX_PAGES_PER_RUN = 40;
// Wall-clock guard. Each page is a fetch plus up to a few PDF downloads and an
// extraction call, so the per-page cost varies a lot; stop cleanly instead of
// being killed mid-write.
const RUN_BUDGET_MS = 600_000;
// Revisit cadence. Suppliers post documents late and replace them with new
// revisions, but far more slowly than they change prices.
const RESCAN_AFTER_DAYS = 60;
// A page we were blocked from was never read, so it does not get the 60-day
// rest. It comes back on this ladder, up to DRY_PASS_LIMITS.document_page times.
const BLOCKED_RETRY_DAYS = [1, 3, 7] as const;

function pageHash(url: string): string {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 24);
}

interface Target {
  pageUrl: string;
  orgId: string;
  supplierId: string | null;
  supplierName: string | null;
  materialId: string | null;
  isInternal: boolean;
}

registerAgent({
  slug: "agent-09-document-retrieval",
  displayName: "Agent 09 - Document Retrieval",
  description:
    "Collects supplier qualification documents (SDS/CoA/TDS/certificates) published on product and supplier pages, stores the files, and records which pages have already been checked.",
  async run(ctx) {
    const admin = createAdminClient();
    const startedAt = Date.now();

    const orgStatuses = await loadOrgStatuses(admin);
    const sourcingOrgIds = [...orgStatuses.byOaId.entries()].filter(([, s]) => sourcingAllowed(s)).map(([id]) => id);
    if (!sourcingOrgIds.length) {
      ctx.setSummary("No orgs with sourcing enabled.");
      return;
    }

    const { data: orgMeta } = await admin.from("orgs").select("id, is_internal").in("id", sourcingOrgIds);
    const isInternalById = new Map<string, boolean>((orgMeta ?? []).map((o: any) => [o.id, !!o.is_internal]));

    // Candidate pages come from two places: quotes an operator is validating
    // (a page we already trust enough to quote from) and marketplace leads
    // (which are usually the only record of a supplier's product page).
    const targets: Target[] = [];
    const seen = new Set<string>();
    const push = (t: Target) => {
      if (!/^https?:\/\//i.test(t.pageUrl)) return;
      // Per client, not per URL: two clients can both need the same supplier
      // page, and dropping the second one leaves that client's docs unfetched.
      const h = orgScopedKey(t.orgId, pageHash(t.pageUrl));
      if (seen.has(h)) return;
      seen.add(h);
      targets.push(t);
    };

    const { data: quoteRows } = await admin
      .from("quote_profiles")
      .select("org_id, supplier_id, supplier_name, material_id, source_url")
      .in("org_id", sourcingOrgIds)
      .not("source_url", "is", null)
      .limit(2000);
    for (const r of (quoteRows ?? []) as any[]) {
      push({
        pageUrl: r.source_url,
        orgId: r.org_id,
        supplierId: r.supplier_id ?? null,
        supplierName: r.supplier_name ?? null,
        materialId: r.material_id ?? null,
        isInternal: isInternalById.get(r.org_id) ?? false,
      });
    }

    const { data: leadRows } = await admin
      .from("leads_in_flight")
      .select("org_id, supplier_id, supplier_name, material_id, payload")
      .in("org_id", sourcingOrgIds)
      .eq("status", "active")
      .limit(3000);
    for (const r of (leadRows ?? []) as any[]) {
      const p = (r.payload ?? {}) as any;
      for (const url of [p.source_url, p.supplier_website]) {
        if (!url) continue;
        push({
          pageUrl: url,
          orgId: r.org_id,
          supplierId: r.supplier_id ?? null,
          supplierName: r.supplier_name ?? null,
          materialId: r.material_id ?? null,
          isInternal: isInternalById.get(r.org_id) ?? false,
        });
      }
    }

    // Pages Agent 05 read a price from. When the on-file URL was dead or wrong,
    // the pull web_searches its way to the real product page and records it here
    // rather than on the quote, so without this source the better page is the one
    // page we never scan for documents.
    const { data: findingRows } = await admin
      .from("marketplace_check_findings")
      .select("org_id, supplier_id, supplier_name, material_id, source_url, created_at")
      .in("org_id", sourcingOrgIds)
      .not("source_url", "is", null)
      .order("created_at", { ascending: false })
      .limit(1000);
    for (const r of (findingRows ?? []) as any[]) {
      push({
        pageUrl: r.source_url,
        orgId: r.org_id,
        supplierId: r.supplier_id ?? null,
        supplierName: r.supplier_name ?? null,
        materialId: r.material_id ?? null,
        isInternal: isInternalById.get(r.org_id) ?? false,
      });
    }

    // Drop pages already checked recently. A page that yielded nothing is
    // recorded too, so the queue actually advances instead of re-fetching the
    // same misses every run.
    const cutoff = new Date(Date.now() - RESCAN_AFTER_DAYS * 86_400_000).toISOString();
    const nowIso = new Date().toISOString();
    const scannedRecently = new Set<string>();
    const blockedPasses = new Map<string, number>();
    const hashes = targets.map((t) => pageHash(t.pageUrl));
    for (let i = 0; i < hashes.length; i += 500) {
      const { data } = await admin
        .from("document_page_scans")
        .select("org_id, page_hash, last_scanned_at, retry_after, blocked_passes")
        .in("page_hash", hashes.slice(i, i + 500));
      // Scoped by client: documents are stored per-org, so one client scanning a
      // page must not skip it for every other client for the next 60 days.
      for (const r of (data ?? []) as any[]) {
        const key = orgScopedKey(r.org_id, r.page_hash);
        blockedPasses.set(key, Number(r.blocked_passes ?? 0));
        // A page we were blocked from carries a short retry clock that overrides
        // the sixty-day one: it was never read, so it was never scanned.
        const due = r.retry_after != null && r.retry_after <= nowIso;
        if (r.last_scanned_at >= cutoff && !due) scannedRecently.add(key);
      }
    }

    // Real clients before internal test orgs: this is a capped queue and the
    // cap is the scarce resource.
    const queue = targets
      .filter((t) => !scannedRecently.has(orgScopedKey(t.orgId, pageHash(t.pageUrl))))
      .sort((a, b) => Number(a.isInternal) - Number(b.isInternal))
      .slice(0, MAX_PAGES_PER_RUN);

    await ctx.log(
      `${targets.length} candidate page(s), ${scannedRecently.size} checked within ${RESCAN_AFTER_DAYS}d, scanning ${queue.length}`,
      { step: "queue" }
    );
    if (!queue.length) {
      ctx.setSummary(`No pages due. ${targets.length} candidate page(s) all checked within ${RESCAN_AFTER_DAYS} days.`);
      return;
    }

    let pagesScanned = 0;
    let docsStored = 0;
    let docsHealed = 0;
    let pagesWithDocs = 0;
    let blocked = 0;
    let docErrors = 0;
    let extractFailures = 0;

    for (const t of queue) {
      if (Date.now() - startedAt > RUN_BUDGET_MS) {
        await ctx.log(`Budget reached after ${pagesScanned} page(s); remainder drains next run.`, { step: "budget" });
        break;
      }

      let res;
      try {
        res = await retrieveDocumentsFromUrl(admin, {
          orgId: t.orgId,
          pageUrl: t.pageUrl,
          supplierId: t.supplierId,
          supplierName: t.supplierName,
          materialId: t.materialId,
        });
      } catch (e: any) {
        res = {
          pageUrl: t.pageUrl,
          candidates: 0,
          inserted: 0,
          skippedDuplicates: 0,
          healed: 0,
          errors: 1,
          extractFailures: 0,
          docs: [],
          note: `error: ${String(e?.message ?? e).slice(0, 120)}`,
        };
      }

      // A page whose links all failed to download looks identical to a page with
      // no links unless the reason is recorded, which is exactly how the first
      // live run hid a bug behind 21 blank rows.
      if (!res.note && res.candidates > 0 && res.inserted === 0) {
        res.note =
          `found ${res.candidates} link(s), stored 0` +
          ` (${res.skippedDuplicates} already held, ${res.errors} fetch/insert error(s))`;
      }

      pagesScanned++;
      docsStored += res.inserted;
      docsHealed += res.healed;
      if (res.inserted || res.healed) pagesWithDocs++;
      if (/\b(403|429)\b/.test(res.note ?? "")) blocked++;
      docErrors += res.errors;
      extractFailures += res.extractFailures;

      const h = pageHash(t.pageUrl);
      const { data: prior } = await admin
        .from("document_page_scans")
        .select("scan_count")
        .eq("page_hash", h)
        .maybeSingle();
      // PERS-03. A 403, a 429 and the synthesised `errors: 1` from the catch
      // above are not readings of the page — nothing was seen — yet the row was
      // written the same way as a clean scan, which rests the page for
      // RESCAN_AFTER_DAYS. Give those a short lengthening retry clock instead,
      // bounded so a permanently walled page eventually settles.
      const wall = /\b(403|429)\b/.test(res.note ?? "") || (res.note ?? "").startsWith("error:");
      const key = orgScopedKey(t.orgId, h);
      const pass = advanceDryPass(
        { dry: blockedPasses.get(key) ?? 0, done: false },
        wall ? "dry" : "found",
        "document_page"
      );
      await admin.from("document_page_scans").upsert(
        {
          page_hash: h,
          page_url: t.pageUrl,
          org_id: t.orgId,
          supplier_id: t.supplierId,
          supplier_name: t.supplierName,
          last_scanned_at: new Date().toISOString(),
          scan_count: ((prior as any)?.scan_count ?? 0) + 1,
          docs_found: res.inserted + res.healed,
          note: res.note ?? null,
          blocked_passes: wall ? pass.dry : 0,
          retry_after: wall && !pass.done ? retryAfter(pass.dry, BLOCKED_RETRY_DAYS) : null,
        },
        { onConflict: "org_id,page_hash" }
      );

      if (res.inserted || res.healed) {
        await ctx.log(`${t.supplierName ?? "unknown"}: ${res.inserted} new + ${res.healed} backfilled document(s) [${res.docs.map((d) => d.docType).join(", ")}]`, {
          step: "retrieve",
          data: { pageUrl: t.pageUrl },
        });
      }
    }

    // A stored document should tick the requirement it satisfies, not wait for
    // an operator to notice it arrived.
    let requirementsTicked = 0;
    for (const orgId of new Set(queue.map((t) => t.orgId))) {
      const r = await syncDocRequirementsMet(admin, orgId);
      requirementsTicked += r.updated;
    }
    if (requirementsTicked) {
      await ctx.log(`${requirementsTicked} quote profile(s) had a document requirement met.`, { step: "requirements" });
    }

    ctx.setItemsProcessed(pagesScanned);
    ctx.setMetadata({
      pages_scanned: pagesScanned,
      pages_with_docs: pagesWithDocs,
      docs_stored: docsStored,
      docs_healed: docsHealed,
      blocked,
      doc_errors: docErrors,
      extract_failures: extractFailures,
      requirements_ticked: requirementsTicked,
    });
    ctx.setSummary(
      `${docsStored} document(s) from ${pagesWithDocs}/${pagesScanned} page(s)` +
        (docsHealed ? `; ${docsHealed} existing record(s) given their file` : "") +
        (blocked ? `; ${blocked} page(s) blocked (403/429)` : "")
    );
    ctx.setStatus(docsStored > 0 || docsHealed > 0 || pagesScanned > 0 ? "success" : "partial");
  },
});
