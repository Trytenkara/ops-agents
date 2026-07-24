import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession } from "@/lib/auth";
import { orgDisplayName } from "@/lib/org-display";
import { correctMaterialSpelling } from "@/lib/material-spelling";
import { getClientRequirements, type RequirementItem } from "@/lib/tenkara-requirements";
import { cn } from "@/lib/utils";
import { ListPageHeader } from "@/components/list-page-header";
import { ExtractionQuoteBoard } from "@/components/extraction-quote-board";

export const dynamic = "force-dynamic";

const DOC_TYPE_LABEL: Record<string, string> = {
  coa: "CoA",
  sds: "SDS",
  tds: "TDS",
  certificate: "Certificate",
  statement: "Statement",
  testing: "Testing",
  price_sheet: "Price sheet",
  other: "Document",
};

// A one-line summary of the fields we parsed out of a document, chosen per type.
function docSummary(d: any): string | null {
  const f = (d.extracted ?? {}) as Record<string, any>;
  const parts: string[] = [];
  switch (d.doc_type) {
    case "coa":
      if (f.assay_percent != null) parts.push(`${f.assay_percent}% assay`);
      if (f.grade) parts.push(String(f.grade));
      if (f.lot_number) parts.push(`lot ${f.lot_number}`);
      break;
    case "certificate":
      if (f.certificate_type) parts.push(String(f.certificate_type));
      if (f.certificate_number) parts.push(`#${f.certificate_number}`);
      if (f.issuer) parts.push(String(f.issuer));
      break;
    case "sds":
      if (f.cas_number) parts.push(`CAS ${f.cas_number}`);
      if (f.revision_date) parts.push(`rev ${f.revision_date}`);
      break;
    case "statement":
      if (f.statement_type) parts.push(String(f.statement_type));
      else if (f.summary) parts.push(String(f.summary));
      break;
    case "testing":
      if (f.test_type) parts.push(String(f.test_type));
      if (f.result_summary) parts.push(String(f.result_summary));
      break;
    default:
      if (f.summary) parts.push(String(f.summary));
  }
  return parts.length ? parts.join(" · ") : null;
}

// Expiry status relative to today, for the badge on a received document.
function expiryStatus(expiresOn: string | null): { label: string; tone: "expired" | "soon" | "ok" } | null {
  if (!expiresOn) return null;
  const exp = new Date(expiresOn + "T00:00:00Z").getTime();
  if (Number.isNaN(exp)) return null;
  const days = Math.round((exp - Date.now()) / 86_400_000);
  if (days < 0) return { label: `expired ${expiresOn}`, tone: "expired" };
  if (days <= 60) return { label: `expires ${expiresOn} (${days}d)`, tone: "soon" };
  return { label: `valid to ${expiresOn}`, tone: "ok" };
}

// Platform Extraction — the per-client "live pool" the Tenkara platform draws
// from (pipeline-framing spec, Part 1). Surfaces everything the agents pulled
// out of supplier replies + attachments so Evan can pull it into Tenkara,
// grouped under the spec's platform-facing names. Read-only: Tenkara is never
// written from here.
export default async function OrgExtractionPage({ params }: { params: { slug: string } }) {
  await getSession();
  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, slug, name, display_name, tenkara_org_id")
    .eq("slug", params.slug)
    .maybeSingle();
  if (!org) notFound();

  const { data: staged } = await admin
    .from("staged_quotes")
    .select(
      "id, supplier_id, supplier_name, material_name, grade, price, case_size, unit_of_measurement, unit_price, currency, lead_time_days, lead_time_text, moq_quantity, moq_unit, payment_terms, source, source_attachment_name, confidence, status, created_at"
    )
    .eq("org_id", org.id)
    .neq("status", "dismissed")
    .order("created_at", { ascending: false })
    .limit(1000);

  const rows = (staged ?? []).map((r: any) => ({ ...r, material_name: correctMaterialSpelling(r.material_name) }));

  // Client qualification requirements, read from Tenkara (Client Settings →
  // Sourcing Rules). Best-effort — a Tenkara hiccup just hides the checklist.
  let requirements: RequirementItem[] = [];
  try {
    requirements = await getClientRequirements(org.tenkara_org_id);
  } catch {
    requirements = [];
  }

  // Documents suppliers have actually sent back, captured from reply
  // attachments, with the fields we parsed out of each. Counted per type so The
  // bench can mark a requirement received, and listed with their key values.
  const { data: docs } = await admin
    .from("supplier_documents")
    .select("id, doc_type, supplier_id, file_name, supplier_name, source_url, expires_on, extracted, created_at")
    .eq("org_id", org.id)
    .order("created_at", { ascending: false })
    .limit(500);
  const docList = (docs ?? []) as any[];
  const docCountByType = new Map<string, number>();
  for (const d of docList) docCountByType.set(d.doc_type, (docCountByType.get(d.doc_type) ?? 0) + 1);
  // Requirement key → the document type that satisfies it. Sample is physical
  // (no document), so it has no mapping.
  const REQ_KEY_TO_DOCTYPE: Record<string, string> = {
    coa: "coa",
    sds: "sds",
    tds: "tds",
    certifications: "certificate",
    custom_statements: "statement",
    custom_testing: "testing",
    custom_documentation: "other",
  };
  const receivedFor = (key: string): number => docCountByType.get(REQ_KEY_TO_DOCTYPE[key] ?? "") ?? 0;
  const isDocRequirement = (r: RequirementItem) => !!REQ_KEY_TO_DOCTYPE[r.key];
  const dealbreakerUnmet = (r: RequirementItem) => r.dealbreaker && isDocRequirement(r) && receivedFor(r.key) === 0;
  // Dealbreaker documents the client requires that no supplier has provided yet.
  // Deduped by label so a pre+post duplicate shows once in the banner.
  const unmetDealbreakers = Array.from(
    new Map(requirements.filter(dealbreakerUnmet).map((r) => [r.label, r])).values()
  );

  // Per-supplier qualification: which required document types each supplier we've
  // heard from has provided, vs. what the client requires. Keyed by supplier_id
  // when known, else normalized name, so quotes and documents from the same
  // supplier line up. The client-level counts above answer "has anyone sent this";
  // this answers "is THIS vendor qualified".
  const normName = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const supKey = (id: string | null, name: string | null) => id || `name:${normName(name)}`;
  const requiredDocTypes = new Map<string, { label: string; dealbreaker: boolean }>();
  for (const r of requirements) {
    const dt = REQ_KEY_TO_DOCTYPE[r.key];
    if (!dt) continue;
    const cur = requiredDocTypes.get(dt);
    requiredDocTypes.set(dt, { label: DOC_TYPE_LABEL[dt] ?? dt, dealbreaker: (cur?.dealbreaker ?? false) || r.dealbreaker });
  }
  const suppliers = new Map<string, { name: string; provided: Set<string> }>();
  for (const r of rows) {
    const k = supKey(r.supplier_id ?? null, r.supplier_name ?? null);
    if (!suppliers.has(k)) suppliers.set(k, { name: r.supplier_name ?? "Unknown supplier", provided: new Set() });
  }
  for (const d of docList) {
    const k = supKey(d.supplier_id ?? null, d.supplier_name ?? null);
    const s = suppliers.get(k) ?? { name: d.supplier_name ?? "Unknown supplier", provided: new Set<string>() };
    s.provided.add(d.doc_type);
    suppliers.set(k, s);
  }
  const requiredTypeList = Array.from(requiredDocTypes.entries()); // [docType, {label, dealbreaker}]
  const supplierRows = Array.from(suppliers.values())
    .map((s) => {
      const missingDealbreakers = requiredTypeList.filter(([dt, m]) => m.dealbreaker && !s.provided.has(dt));
      return { ...s, missingDealbreakers };
    })
    .sort((a, b) => b.missingDealbreakers.length - a.missingDealbreakers.length || a.name.localeCompare(b.name));

  return (
    <div className="space-y-8">
      <ListPageHeader
        level={2}
        title="Platform Extraction"
        description={`The live pool of supplier info the agents have pulled for ${orgDisplayName(org)}. Grouped the way the platform frames it — copy any row to pull it into Tenkara.`}
        collectedBy="Agent 08 / 13 / 15 (reply + attachment extraction)"
        explainer={
          <>
            Everything here was extracted from supplier replies and price sheets — nothing is manually entered. Use{" "}
            <span className="font-medium text-foreground">Copy</span> on a row to grab a tab-separated line you can paste
            straight into a Tenkara quote.
          </>
        }
      />

      <section className="space-y-3">
        <div className="flex items-baseline gap-2">
          <h3 className="font-serif text-lg tracking-tight">Quote board</h3>
          <span className="text-xs text-muted-foreground">{rows.length} extracted line{rows.length === 1 ? "" : "s"}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Prices, grade, lead time, MOQ, and payment terms captured from what suppliers sent back.
        </p>
        <ExtractionQuoteBoard rows={rows} slug={org.slug} />
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline gap-2">
          <h3 className="font-serif text-lg tracking-tight">The bench</h3>
          <span className="text-xs text-muted-foreground">
            {requirements.length} qualification requirement{requirements.length === 1 ? "" : "s"}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          What this client requires to qualify a vendor, from their Tenkara sourcing rules. Items marked{" "}
          <span className="font-medium text-foreground">Requested</span> are added to the supplier follow-up email so we
          retrieve them; <span className="font-medium text-foreground">Dealbreaker</span> items block qualification if missing.
        </p>
        {unmetDealbreakers.length > 0 && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
            <span className="font-medium text-destructive">
              {unmetDealbreakers.length} dealbreaker document{unmetDealbreakers.length === 1 ? "" : "s"} not yet received
            </span>
            <span className="text-muted-foreground"> — qualification is blocked until these arrive: </span>
            <span className="text-foreground">{unmetDealbreakers.map((r) => r.label).join(", ")}</span>
          </div>
        )}
        {requirements.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
            No qualification requirements configured for this client in Tenkara (Client Settings → Sourcing Rules).
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {requirements.map((r, i) => (
              <li key={`${r.phase}-${r.key}-${i}`} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <span className="text-sm">{r.label}</span>
                  {r.detail && r.kind !== "sample" && <span className="ml-2 text-xs text-muted-foreground">({r.detail})</span>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {r.phase === "pre_order" ? "Pre-order" : "Post-order"}
                  </span>
                  {r.requested && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary">
                      Requested
                    </span>
                  )}
                  {r.dealbreaker && (
                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-destructive">
                      Dealbreaker
                    </span>
                  )}
                  {r.kind !== "sample" && r.kind !== "spec" && receivedFor(r.key) > 0 && (
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-600">
                      {receivedFor(r.key)} received
                    </span>
                  )}
                  {dealbreakerUnmet(r) && (
                    <span className="rounded-full bg-destructive px-2 py-0.5 text-[10px] uppercase tracking-wider text-destructive-foreground">
                      Not received
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {requiredTypeList.length > 0 && supplierRows.length > 0 && (
          <div className="space-y-2 pt-2">
            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">By supplier</h4>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {supplierRows.map((s, i) => {
                const blocked = s.missingDealbreakers.length > 0;
                return (
                  <li key={`${s.name}-${i}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{s.name}</span>
                      {blocked ? (
                        <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-destructive">
                          Blocked: missing {s.missingDealbreakers.map(([, m]) => m.label).join(", ")}
                        </span>
                      ) : (
                        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-600">
                          Qualified
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      {requiredTypeList.map(([dt, m]) => {
                        const has = s.provided.has(dt);
                        const tone = has
                          ? "bg-emerald-500/10 text-emerald-600"
                          : m.dealbreaker
                          ? "bg-destructive/10 text-destructive"
                          : "bg-secondary text-muted-foreground";
                        return (
                          <span key={dt} className={cn("rounded-full px-2 py-0.5 text-[10px]", tone)}>
                            {has ? "✓" : "✗"} {m.label}
                          </span>
                        );
                      })}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Received counts and the documents below come from what suppliers attached to their replies, classified and parsed
          on arrival. Per-supplier status matches documents to that vendor by id or name.
        </p>

        {docList.length > 0 && (
          <div className="space-y-2 pt-2">
            <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Documents received</h4>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {docList.map((d) => {
                const summary = docSummary(d);
                const exp = expiryStatus(d.expires_on);
                return (
                  <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {DOC_TYPE_LABEL[d.doc_type] ?? d.doc_type}
                      </span>
                      <span className="truncate text-sm">
                        {d.supplier_name ?? "Unknown supplier"}
                        {summary && <span className="ml-2 text-xs text-muted-foreground">{summary}</span>}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {exp && (
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
                            exp.tone === "expired"
                              ? "bg-destructive/10 text-destructive"
                              : exp.tone === "soon"
                              ? "bg-amber-500/10 text-amber-600"
                              : "bg-emerald-500/10 text-emerald-600"
                          )}
                        >
                          {exp.label}
                        </span>
                      )}
                      {d.source_url && (
                        <a
                          href={d.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                        >
                          View
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
