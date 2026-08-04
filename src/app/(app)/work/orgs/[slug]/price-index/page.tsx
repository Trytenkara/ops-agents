import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { orgDisplayName } from "@/lib/org-display";
import { operatorRoles, primaryRole } from "@/lib/operator";
import { resolveSupplierNamesWithFallback, resolveMaterialNames, resolveQuoteRefs, resolveQuoteExpiries } from "@/lib/tenkara-names";
import { correctMaterialSpelling } from "@/lib/material-spelling";
import { ListPageHeader } from "@/components/list-page-header";
import { MarketplaceFindingsList } from "@/components/marketplace-findings-list";
import { RequoteList, type RequoteRow } from "@/components/requote-list";
import { DirectPricesOnFile, type DirectPriceRow } from "@/components/direct-prices-on-file";
import { PriceIndexTabs } from "@/components/price-index-tabs";
import { QuoteValidationView } from "@/components/quote-validation-view";
import { getQuoteProfiles } from "@/lib/quote-profiles";
import { getOrgAssignmentContext, resolveOperatorId } from "@/lib/operator-assignment";
import { getSupplierProfiles } from "@/lib/supplier-profiles";
import { CasesSection } from "@/components/cases-section";
import { loadOrgCases, caseCategory } from "@/lib/org-cases";
import { loadMarketplaceCaseDims, fmtCaseDims } from "@/lib/marketplace-case-dims";
import { loadMaterialDensities } from "@/lib/material-density";
import { cn } from "@/lib/utils";
import { aggregatorNameFromPayload, aggregatorNameOf } from "@/lib/aggregator-hosts";
import { leadMarketKind, type MarketKind } from "@/lib/lead-market";

export const dynamic = "force-dynamic";

const STATUSES = [
  { value: "pending_review", label: "Pending review" },
  { value: "approved", label: "Approved" },
  { value: "dismissed", label: "Dismissed" },
] as const;
type Status = (typeof STATUSES)[number]["value"];

// Price Index — one place to keep a client's pricing current across suppliers.
// Marketplace suppliers: re-check the current public price (Agent 05). Direct
// suppliers: there's no public price, so an expiring quote becomes a re-quote
// draft (Agent 02). Folds in the old Price Changes tab.
export default async function OrgPriceIndexPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { status?: string };
}) {
  const session = (await getSession())!;
  const status: Status = STATUSES.some((s) => s.value === searchParams?.status)
    ? (searchParams!.status as Status)
    : "pending_review";

  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name, display_name").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const [findingsRes, draftsRes, stagedRes, leadsRes, clientTagsRes, orgClientsRes] = await Promise.all([
    admin
      .from("marketplace_check_findings")
      .select(
        "id, supplier_name, material_name, baseline_price, current_price, currency, pack_size, pct_change, classification, status, source_url, notes, created_at, orgs(slug, name)"
      )
      .eq("org_id", org.id)
      .eq("status", status)
      .order("pct_change", { ascending: false, nullsFirst: false })
      .limit(200),
    admin
      .from("draft_references")
      .select(
        "id, subject, supplier_id, material_id, quote_id, status, created_at, metadata, assigned_operator, users:users!draft_references_assigned_operator_fkey(display_name, email, user_roles(role)), reviewer:users!draft_references_reviewer_fkey(display_name), agents(slug)"
      )
      .eq("org_id", org.id)
      .eq("agents.slug", "agent-02-revalidation")
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .from("staged_quotes")
      .select("id, supplier_id, supplier_name, material_id, material_name, price, case_size, unit_of_measurement, unit_price, currency, grade, status, created_at, case_type, case_dimensions")
      .eq("org_id", org.id)
      .not("material_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1000),
    // Marketplace prices we've already pulled (Agent 05 lead-price-pull) live on
    // the lead payload, not in findings. Surface them so the Live Price Index
    // shows the *current* price on file, not only re-check deltas.
    admin
      .from("leads_in_flight")
      .select("id, supplier_name, material_name, source, payload, created_at")
      .eq("org_id", org.id)
      .not("payload->price_tiers", "is", null)
      .limit(1000),
    admin.from("material_client_tags").select("material_name, org_client_id").eq("org_id", org.id).not("org_client_id", "is", null),
    admin.from("org_clients").select("id, name").eq("org_id", org.id).order("name"),
  ]);

  const findings = (findingsRes.data ?? []).map((f: any) => ({ ...f, material_name: correctMaterialSpelling(f.material_name) }));
  const tagsByMaterialName: Record<string, string> = {};
  for (const t of (clientTagsRes.data ?? []) as any[]) {
    if (t.material_name && t.org_client_id) tagsByMaterialName[t.material_name.toLowerCase()] = t.org_client_id;
  }
  const orgClients = ((orgClientsRes.data ?? []) as any[]).map((r) => ({ id: r.id as string, name: r.name as string }));
  const draftRows = (draftsRes.data ?? []).filter((d: any) => d.agents?.slug === "agent-02-revalidation");

  // Latest captured supplier-reply quote — the price that came BACK for a direct
  // re-quote draft. Rows are newest-first, so the first per key wins. We index by
  // both supplier_id and (normalized) supplier_name so a reply still matches when
  // the supplier_id didn't resolve during extraction — name is the fallback.
  const normName = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const capturedById = new Map<string, any>();
  const capturedByName = new Map<string, any>();
  for (const s of (stagedRes.data ?? []) as any[]) {
    if (s.status === "dismissed") continue;
    if (s.supplier_id) {
      const k = `${s.supplier_id}|${s.material_id}`;
      if (!capturedById.has(k)) capturedById.set(k, s);
    }
    if (s.supplier_name) {
      const k = `${normName(s.supplier_name)}|${s.material_id}`;
      if (!capturedByName.has(k)) capturedByName.set(k, s);
    }
  }

  const assigned = await getAssignedOrgIds(session);
  const canAct =
    hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]) &&
    (seesAllOrgs(session) || (assigned?.includes(org.id) ?? false));

  // Resolve supplier/material/quote names for the direct re-quote drafts.
  let supplierNames = new Map<string, string>();
  let materialNames = new Map<string, string>();
  let quoteRefs = new Map<string, string>();
  let quoteExpiries = new Map<string, string>();
  try {
    [supplierNames, materialNames, quoteRefs, quoteExpiries] = await Promise.all([
      resolveSupplierNamesWithFallback(draftRows.map((d: any) => d.supplier_id).filter(Boolean)),
      resolveMaterialNames(draftRows.map((d: any) => d.material_id).filter(Boolean)),
      resolveQuoteRefs(draftRows.map((d: any) => d.quote_id).filter(Boolean)),
      resolveQuoteExpiries(draftRows.map((d: any) => d.quote_id).filter(Boolean)),
    ]);
  } catch {
    // Tenkara unreachable — rows fall back to "name unavailable".
  }

  const requotes: RequoteRow[] = draftRows.map((d: any) => {
    const supplierName = d.supplier_id ? supplierNames.get(d.supplier_id) ?? null : null;
    const captured = d.material_id
      ? capturedById.get(`${d.supplier_id}|${d.material_id}`) ??
        (supplierName ? capturedByName.get(`${normName(supplierName)}|${d.material_id}`) ?? null : null)
      : null;
    return {
      id: d.id,
      subject: d.subject ?? null,
      supplierId: d.supplier_id ?? null,
      supplierName,
      materialId: d.material_id ?? null,
      materialName: d.material_id ? materialNames.get(d.material_id) ?? null : null,
      quoteRef: d.quote_id ? quoteRefs.get(d.quote_id) ?? null : null,
      quoteExpiry: d.quote_id ? quoteExpiries.get(d.quote_id) ?? null : null,
      status: d.status,
      createdAt: d.created_at ?? null,
      metadata: d.metadata,
      assignedName: d.users?.display_name ?? null,
      assignedEmail: d.users?.email ?? null,
      assignedRole: primaryRole(operatorRoles(d.users)),
      reviewerName: d.reviewer?.display_name ?? null,
      returnedPrice: captured?.price ?? null,
      returnedUnitPrice: captured?.unit_price ?? null,
      returnedUnitOfMeasurement: captured?.unit_of_measurement ?? null,
      returnedCurrency: captured?.currency ?? null,
      returnedGrade: captured?.grade ?? null,
      returnedStatus: captured?.status ?? null,
    };
  });

  // Marketplace prices already on file (pulled into leads_in_flight.payload by
  // Agent 05). Show them as "price on file" rows so a fresh client sees current
  // prices immediately — not just re-check deltas. Skip any supplier×material a
  // re-check finding already covers (the finding row shows the same price), and
  // only fold them into the default "pending review" view so the status pills
  // keep filtering the re-check workflow cleanly.
  const findingPairKey = (supplier: string | null | undefined, material: string | null | undefined) =>
    `${normName(supplier)}|${normName(material)}`;
  const findingPairs = new Set(findings.map((f: any) => findingPairKey(f.supplier_name, f.material_name)));
  const marketplaceOnFile: any[] =
    status !== "pending_review"
      ? []
      : ((leadsRes.data ?? []) as any[]).flatMap((l: any) => {
          const tiers = Array.isArray(l.payload?.price_tiers) ? l.payload.price_tiers : [];
          if (!tiers.length) return [];
          if (findingPairs.has(findingPairKey(l.supplier_name, l.material_name))) return [];
          const src = (l.payload?.source_url ?? l.payload?.supplier_website ?? null) as string | null;
          const aggregator =
            leadMarketKind(l.payload?.site_type) === "aggregator" ? aggregatorNameFromPayload(l.payload) : null;
          return tiers.map((t: any, i: number) => ({
            aggregator,
            id: `lead-${l.id}-${i}`,
            supplier_name: l.supplier_name ?? null,
            material_name: correctMaterialSpelling(l.material_name),
            pack_size: t.pack_size ?? null,
            unit_price: t.unit_price ?? null,
            // On file = prior scrape's price (previous_price); Current = latest price.
            // Δ = change on-file → current. Lets the row read as last-vs-current.
            baseline_price: t.previous_price ?? null,
            current_price: t.price ?? null,
            pct_change:
              t.previous_price != null && t.price != null && t.previous_price !== 0
                ? Math.round(((t.price - t.previous_price) / t.previous_price) * 1000) / 10
                : null,
            classification: "price_on_file",
            status: "on_file",
            currency: "USD",
            source_url: src,
            notes: null,
            created_at: (l.payload?.price_tiers_updated_at ?? l.created_at ?? null) as string | null,
            kind: "on_file" as const,
          }));
        });
  // Aggregator listings (Alibaba, IndiaMART, ...) are prices too, but they are
  // indicative asks off a multi-seller inquiry platform rather than something you
  // can check out on, so they get their own tab instead of being read as a
  // marketplace price. Findings carry no site_type, so classify them by host.
  const allPriceRows = [...findings, ...marketplaceOnFile].map((r: any) => ({
    ...r,
    aggregator: r.aggregator ?? aggregatorNameOf(r.source_url),
  }));
  const marketplaceRows = allPriceRows.filter((r: any) => !r.aggregator);
  const aggregatorRows = allPriceRows.filter((r: any) => r.aggregator);

  // Direct-supplier prices on file (staged_quotes) that aren't tied to an open
  // re-quote draft — these are the current non-marketplace prices we hold.
  const consumedDirectKeys = new Set<string>();
  for (const d of draftRows) {
    if (!d.material_id) continue;
    const supplierName = d.supplier_id ? supplierNames.get(d.supplier_id) ?? null : null;
    if (d.supplier_id) consumedDirectKeys.add(`${d.supplier_id}|${d.material_id}`);
    if (supplierName) consumedDirectKeys.add(`${normName(supplierName)}|${d.material_id}`);
  }
  const directOnFileMap = new Map<string, any>();
  const previousDirectMap = new Map<string, any>();
  for (const s of (stagedRes.data ?? []) as any[]) {
    if (s.status === "dismissed" || !s.material_id) continue;
    const k = `${s.supplier_id ?? normName(s.supplier_name)}|${s.material_id}`;
    if (consumedDirectKeys.has(k)) continue;
    if (!directOnFileMap.has(k)) directOnFileMap.set(k, s); // newest-first, first wins
    else if (!previousDirectMap.has(k)) previousDirectMap.set(k, s); // second-newest = on-file baseline
  }
  const directOnFile: DirectPriceRow[] = Array.from(directOnFileMap.entries()).map(([k, s]: [string, any]) => {
    const previous = previousDirectMap.get(k);
    return {
      id: s.id,
    supplierName: s.supplier_name ?? null,
    materialName: s.material_name ? correctMaterialSpelling(s.material_name) : null,
    price: s.price != null ? Number(s.price) : null,
    unitPrice: s.unit_price != null ? Number(s.unit_price) : null,
    previousPrice: previous?.price != null ? Number(previous.price) : null,
    previousUnitPrice: previous?.unit_price != null ? Number(previous.unit_price) : null,
    unitOfMeasurement: s.unit_of_measurement ?? previous?.unit_of_measurement ?? null,
    currency: s.currency ?? null,
    grade: s.grade ?? null,
    status: s.status ?? null,
    createdAt: s.created_at ?? null,
    caseDims: fmtCaseDims({
      case_type: s.case_type ?? null,
      width: s.case_dimensions?.width ?? null,
      height: s.case_dimensions?.height ?? null,
      length: s.case_dimensions?.length ?? null,
      weight_kg: s.case_dimensions?.packaging_case_weight ?? null,
      }),
    };
  });

  const quoteProfiles = await getQuoteProfiles(admin, org.id).catch(() => []);

  // Quote Validation groups by supplier, and a quote itself carries no market
  // kind — so hand the view the supplier's kind. The validated supplier profile
  // wins; leads only fill in suppliers that have no profile yet.
  const supplierTypes: Record<string, MarketKind> = {};
  for (const l of (leadsRes.data ?? []) as any[]) {
    const kind = leadMarketKind(l.payload?.site_type);
    if (kind && l.supplier_name) supplierTypes[`name:${l.supplier_name.toLowerCase()}`] = kind;
  }
  for (const p of await getSupplierProfiles(admin, org.id).catch(() => [])) {
    if (!p.supplier_type) continue;
    if (p.supplier_id) supplierTypes[`id:${p.supplier_id}`] = p.supplier_type;
    supplierTypes[`name:${p.supplier_name.toLowerCase()}`] = p.supplier_type;
  }

  // Owning operator per supplier, so an operator can sort the validation queue
  // down to their own book. Same resolution as the Suppliers and Leads tabs: a
  // manual claim wins, else the sticky auto owner.
  const assignmentCtx = await getOrgAssignmentContext(admin, org.id);
  const operatorNameById = new Map(assignmentCtx.pool.map((op) => [op.id, op.name]));
  const supplierNameById = new Map<string, string>();
  for (const l of (leadsRes.data ?? []) as any[]) {
    if (l.supplier_id && l.supplier_name) supplierNameById.set(l.supplier_id, l.supplier_name);
  }
  const supplierOperators: Record<string, string> = {};
  for (const sid of new Set(quoteProfiles.map((q) => q.supplier_id).filter(Boolean) as string[])) {
    const opId = resolveOperatorId(assignmentCtx, sid, (supplierTypes[`id:${sid}`] as MarketKind | undefined) ?? null);
    const name = opId ? operatorNameById.get(opId) : null;
    if (!name) continue;
    supplierOperators[`id:${sid}`] = name;
    // Quotes staged before their supplier was linked carry only a name.
    const sname = supplierNameById.get(sid);
    if (sname) supplierOperators[`name:${sname.toLowerCase()}`] = name;
  }

  const marketplaceDims = await loadMarketplaceCaseDims(admin);
  // Cross-org by design: density is a physical property with a public citation,
  // so a value sourced for one client is valid for every client's same material.
  const densities = await loadMaterialDensities(admin);

  const { openRows: caseOpen, resolvedRows: caseResolved } = await loadOrgCases(admin, org.id);
  const quoteCasesOpen = caseOpen.filter((c) => caseCategory(c.type) === "quote");
  const quoteCasesResolved = caseResolved.filter((c) => caseCategory(c.type) === "quote");

  const base = `/work/orgs/${org.slug}/price-index`;

  return (
    <div className="space-y-6">
      <ListPageHeader
        level={2}
        title="Live Price Index"
        description={`Keep ${orgDisplayName(org)}'s pricing current. Marketplace suppliers are re-checked against their public price; direct suppliers get a re-quote draft to send.`}
        collectedBy="Agent 05 (Marketplace Re-check) + Agent 02 (Revalidation)"
        actions={
          <Link
            href={`/work/orgs/${org.slug}/threads`}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm text-primary hover:bg-secondary/60"
          >
            All conversations in Threads →
          </Link>
        }
        explainer={
          <>
            Marketplace prices are read from public pages — a <span className="font-medium text-foreground">needs manual login</span> flag
            means it&apos;s behind a sign-in wall. Direct suppliers have no public price, so we draft a re-quote email instead.
          </>
        }
      />

      <PriceIndexTabs
        marketplaceCount={marketplaceRows.length}
        aggregatorCount={aggregatorRows.length}
        directCount={requotes.length + directOnFile.length}
        escalationsCount={quoteCasesOpen.length}
        validationCount={quoteProfiles.length}
        validation={
          <QuoteValidationView
            profiles={quoteProfiles}
            canAct={canAct}
            slug={org.slug}
            orgId={org.id}
            supplierTypes={supplierTypes}
            supplierOperators={supplierOperators}
          />
        }
        escalations={
          <section className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Quotes the fleet could not price on its own. A marketplace listing whose price could not be auto-pulled (needs a
              login, a broken link, or no price found on the page) opens here for an operator to pull the price manually.
            </p>
            <CasesSection
              openRows={quoteCasesOpen}
              resolvedRows={quoteCasesResolved}
              slug={org.slug}
              emptyLabel="No quote escalations right now."
            />
          </section>
        }
        marketplace={
          <section className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Current marketplace prices on file. Rows tagged <span className="font-medium text-foreground">price on file</span> are the
              latest pulled price; re-checks also show the current public price vs. what&apos;s on file — approve the ones worth applying.
            </p>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((s) => (
                <Link
                  key={s.value}
                  href={s.value === "pending_review" ? base : `${base}?status=${s.value}`}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    status === s.value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {s.label}
                </Link>
              ))}
            </div>
            {marketplaceRows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">
                No {STATUSES.find((s) => s.value === status)?.label.toLowerCase()} marketplace prices yet.
              </p>
            ) : (
              <MarketplaceFindingsList rows={marketplaceRows} canAct={canAct} slug={org.slug} orgClients={orgClients} tagsByMaterialName={tagsByMaterialName} dimsByPack={marketplaceDims} densities={densities} />
            )}
          </section>
        }
        aggregator={
          <section className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Prices pulled from aggregators (multi-seller platforms such as Alibaba, IndiaMART, or Made-in-China). Every row
              names the platform it came from. Ordering there goes through a Send Inquiry form, not a checkout, so treat these
              as indicative asks to confirm with the seller rather than prices you can transact at.
            </p>
            {aggregatorRows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">No aggregator prices yet.</p>
            ) : (
              <MarketplaceFindingsList rows={aggregatorRows} canAct={canAct} slug={org.slug} orgClients={orgClients} tagsByMaterialName={tagsByMaterialName} dimsByPack={marketplaceDims} densities={densities} />
            )}
          </section>
        }
        direct={
          <section className="space-y-6">
            <div className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Prices on file</h3>
                <p className="text-sm text-muted-foreground">
                  Current direct-supplier prices we hold (from captured quotes) that aren&apos;t being re-quoted right now.
                </p>
              </div>
              {directOnFile.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">No direct prices on file yet.</p>
              ) : (
                <DirectPricesOnFile rows={directOnFile} slug={org.slug} />
              )}
            </div>
            <div className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Re-quotes in flight</h3>
                <p className="text-sm text-muted-foreground">
                  Expiring quotes from non-marketplace suppliers, drafted for a fresh quote. Review and send — the full
                  back-and-forth is logged in{" "}
                  <Link href={`/work/orgs/${org.slug}/threads`} className="text-primary hover:underline">Threads</Link>.
                </p>
              </div>
              {requotes.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">No re-quote drafts right now.</p>
              ) : (
                <RequoteList rows={requotes} slug={org.slug} />
              )}
            </div>
          </section>
        }
      />
    </div>
  );
}
