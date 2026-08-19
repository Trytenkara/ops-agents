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
import { stagedPackLabel } from "@/lib/staged-pack-label";
import { loadSupplierDocIndex } from "@/lib/supplier-doc-index";
import { getClientRequirements, clientDocRules } from "@/lib/tenkara-requirements";
import { getOrgAssignmentContext, orgAutoKey, resolveOperatorId } from "@/lib/operator-assignment";
import { getSupplierProfiles } from "@/lib/supplier-profiles";
import { CasesSection } from "@/components/cases-section";
import { loadOrgCases } from "@/lib/org-cases";
import { loadMarketplaceCaseDims, fmtCaseDims } from "@/lib/marketplace-case-dims";
import { loadMaterialDensities } from "@/lib/material-density";
import { cn } from "@/lib/utils";
import { aggregatorNameFromPayload, aggregatorNameOf } from "@/lib/aggregator-hosts";
import { leadMarketKind, type MarketKind } from "@/lib/lead-market";
import { tierDelta, stagedQuoteDelta } from "@/lib/price-delta";

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
  const { data: org } = await admin.from("orgs").select("id, slug, name, display_name, tenkara_org_id").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const [findingsRes, draftsRes, stagedRes, leadsRes, clientTagsRes, orgClientsRes] = await Promise.all([
    admin
      .from("marketplace_check_findings")
      .select(
        "id, supplier_name, material_name, baseline_price, current_price, currency, pack_size, pct_change, classification, status, source_url, notes, stock_status, stock_note, out_of_stock_since, created_at, orgs(slug, name)"
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
      .select("id, supplier_id, supplier_name, material_id, material_name, price, case_size, unit_of_measurement, unit_price, currency, grade, status, created_at, case_type, case_dimensions, native_price, native_currency, fx_rate, captured_price, captured_fx_rate, extraction_notes, price_source, price_source_at, price_change_source, supplier_price_usd, supplier_price_changed_at")
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
      // A retired lead's price is not a price on file. Without this, deduped
      // duplicates published a second row for the same supplier×material and
      // retired aggregator umbrella rows published the platform's own search
      // page as a supplier.
      .eq("status", "active")
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
          // Re-judged as having no checkout since these tiers were pulled, so the
          // tiers are a stale artifact of the earlier read. Agent 05 stops
          // re-checking the lead at that point, so nothing would ever refresh or
          // clear them and the row would keep publishing indefinitely.
          if (l.payload?.marketplace_pull?.status === "not_marketplace") return [];
          if (findingPairs.has(findingPairKey(l.supplier_name, l.material_name))) return [];
          const src = (l.payload?.source_url ?? l.payload?.supplier_website ?? null) as string | null;
          const aggregator =
            leadMarketKind(l.payload?.site_type) === "aggregator" ? aggregatorNameFromPayload(l.payload) : null;
          // Availability rides on the pull, not the tier: it's a property of the
          // listing, so every pack size on that page shares it.
          const pull = l.payload?.marketplace_pull ?? null;
          return tiers.map((t: any, i: number) => {
            // The USD move, split into the part the seller caused and the part
            // the exchange rate caused. ~20% of these listings are foreign
            // (IndiaMART/TradeIndia in INR), where a total-only Δ tells an
            // operator nothing actionable: "$100 → $105" is a renegotiation
            // trigger if the seller repriced and noise if the rupee moved.
            const split = tierDelta(t);
            return {
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
              currency_delta: split.currencyDelta,
              supplier_delta: split.supplierDelta,
              delta_source: split.source,
              delta_attributable: split.attributable,
              listed_price: t.native_price ?? null,
              listed_currency: t.native_currency ?? null,
              price_source: t.price_source ?? null,
              price_change_source: t.price_change_source ?? null,
              supplier_price_usd: split.supplierPriceUsd,
              supplier_price_changed_at: t.supplier_price_changed_at ?? t.price_changed_at ?? null,
              classification: "price_on_file",
              status: "on_file",
              currency: "USD",
              source_url: src,
              notes: null,
              stock_status: pull?.stock_status ?? null,
              stock_note: pull?.stock_note ?? null,
              out_of_stock_since: pull?.out_of_stock_since ?? null,
              created_at: (l.payload?.price_tiers_updated_at ?? l.created_at ?? null) as string | null,
              kind: "on_file" as const,
            };
          });
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
    const base = `${s.supplier_id ?? normName(s.supplier_name)}|${s.material_id}`;
    if (consumedDirectKeys.has(base)) continue;
    // Keyed per rung. Without the tier, one email quoting a 3-step ladder read as
    // three revisions of one price: the cheapest rung became "current" and the
    // rung above it became the "previous price", inventing a double-digit drop
    // the supplier never made.
    const k = `${base}|${(stagedPackLabel(s) ?? "").toLowerCase()}`;
    if (!directOnFileMap.has(k)) directOnFileMap.set(k, s); // newest-first, first wins
    else if (!previousDirectMap.has(k)) previousDirectMap.set(k, s); // second-newest = on-file baseline
  }
  // Row id → the staged quote it came from, so the owner pass below can read the
  // supplier id without widening the row type the table renders.
  const stagedByRowId = new Map<string, any>();
  const directOnFile: DirectPriceRow[] = Array.from(directOnFileMap.entries()).map(([k, s]: [string, any]) => {
    stagedByRowId.set(s.id, s);
    const previous = previousDirectMap.get(k);
    // Two independent measures, not an additive split (see stagedQuoteDelta):
    // supplier Δ is this quote vs the supplier's previous one at a common rate,
    // currency Δ is this quote's own drift since the day it landed.
    const split = stagedQuoteDelta(s, previous);
    return {
      id: s.id,
    // Filled in below, once the org's operator assignment context exists.
    owner: null as string | null,
    supplierName: s.supplier_name ?? null,
    materialName: s.material_name ? correctMaterialSpelling(s.material_name) : null,
    tier: stagedPackLabel(s),
    price: s.price != null ? Number(s.price) : null,
    unitPrice: s.unit_price != null ? Number(s.unit_price) : null,
    previousPrice: previous?.price != null ? Number(previous.price) : null,
    previousUnitPrice: previous?.unit_price != null ? Number(previous.unit_price) : null,
    currencyDelta: split.currencyDelta,
    supplierDelta: split.supplierDelta,
    deltaSource: split.source,
    currencyAttributable: split.currencyAttributable,
    supplierAttributable: split.supplierAttributable,
    listedPrice: s.native_price != null ? Number(s.native_price) : null,
    listedCurrency: s.native_currency ?? null,
    unitOfMeasurement: s.unit_of_measurement ?? previous?.unit_of_measurement ?? null,
    currency: s.currency ?? null,
    grade: s.grade ?? null,
    status: s.status ?? null,
    priceSource: s.price_source ?? null,
    priceChangeSource: s.price_change_source ?? null,
    supplierOnlyPrice: split.supplierPriceUsd,
    supplierPriceChangedAt: s.supplier_price_changed_at ?? s.created_at ?? null,
    createdAt: s.price_source_at ?? s.created_at ?? null,
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
  // Qualification documents captured for this org, so a quote can show and export
  // the CoA/SDS/TDS behind it instead of just a "met" checkbox.
  const supplierDocs = await loadSupplierDocIndex(admin, org.id).catch(() => ({}));
  // What this client actually requires, read live from their Tenkara settings.
  // The quote card shows it read-only: a client rule is not an ops decision.
  const clientRules = clientDocRules(await getClientRequirements(org.tenkara_org_id).catch(() => []));

  // Quote Validation groups by supplier, and a quote itself carries no market
  // kind — so hand the view the supplier's kind. The validated supplier profile
  // wins; leads only fill in suppliers that have no profile yet.
  const supplierTypes: Record<string, MarketKind> = {};
  for (const l of (leadsRes.data ?? []) as any[]) {
    const kind = leadMarketKind(l.payload?.site_type);
    if (kind && l.supplier_name) supplierTypes[`name:${l.supplier_name.toLowerCase()}`] = kind;
  }
  const supplierProfiles = await getSupplierProfiles(admin, org.id).catch(() => []);
  for (const p of supplierProfiles) {
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
  for (const q of quoteProfiles) {
    if (q.supplier_id && q.supplier_name) supplierNameById.set(q.supplier_id, q.supplier_name);
  }
  const supplierOperators: Record<string, string> = {};
  // Walk the QUOTES, not the supplier ids on them: quote_profiles carries a
  // supplier_id on almost nothing (0 of California Chemicals' 885 rows), so an
  // id-keyed loop produced an empty map and the whole validation queue read
  // "Unassigned" however the org's assignment settings were set. The owner is
  // resolved on the supplier's shared key, so this tab agrees with Leads and
  // Suppliers instead of hashing a quote's own name into a different operator.
  for (const q of quoteProfiles) {
    const sname = q.supplier_name?.trim() || (q.supplier_id ? supplierNameById.get(q.supplier_id) ?? null : null);
    if (!q.supplier_id && !sname) continue;
    // Name matters as much as id here: a supplier that never got a supplier_id on
    // a lead is only classifiable by name, and an unclassified one reads as
    // "direct" and falls out of a marketplace-only scope.
    const hint =
      (q.supplier_id ? (supplierTypes[`id:${q.supplier_id}`] as MarketKind | undefined) : undefined) ??
      (sname ? (supplierTypes[`name:${sname.toLowerCase()}`] as MarketKind | undefined) : undefined) ??
      null;
    const idKey = q.supplier_id ? `id:${q.supplier_id}` : null;
    const nameLookupKey = sname ? `name:${sname.toLowerCase()}` : null;
    if ((idKey && supplierOperators[idKey]) || (nameLookupKey && supplierOperators[nameLookupKey])) continue;
    const opId = resolveOperatorId(
      assignmentCtx,
      orgAutoKey(assignmentCtx, { supplierId: q.supplier_id, supplierName: sname, leadId: q.id }),
      hint,
      sname
    );
    const name = opId ? operatorNameById.get(opId) : null;
    if (!name) continue;
    if (idKey) supplierOperators[idKey] = name;
    // Quotes staged before their supplier was linked carry only a name.
    if (nameLookupKey) supplierOperators[nameLookupKey] = name;
  }

  // Who owns each direct price on file. Resolved on the supplier's shared key,
  // so a supplier reads the same here as on Leads, Suppliers and Quote
  // Validation rather than hashing this row's own id into a different operator.
  for (const r of directOnFile) {
    const staged = stagedByRowId.get(r.id);
    const sname = r.supplierName?.trim() || null;
    const sid = staged?.supplier_id ?? null;
    if (!sid && !sname) continue;
    const cached =
      (sid ? supplierOperators[`id:${sid}`] : undefined) ??
      (sname ? supplierOperators[`name:${sname.toLowerCase()}`] : undefined);
    if (cached) {
      r.owner = cached;
      continue;
    }
    const hint =
      (sid ? (supplierTypes[`id:${sid}`] as MarketKind | undefined) : undefined) ??
      (sname ? (supplierTypes[`name:${sname.toLowerCase()}`] as MarketKind | undefined) : undefined) ??
      null;
    const opId = resolveOperatorId(
      assignmentCtx,
      orgAutoKey(assignmentCtx, { supplierId: sid, supplierName: sname, leadId: r.id }),
      hint,
      sname
    );
    r.owner = (opId ? operatorNameById.get(opId) : null) ?? null;
  }

  const marketplaceDims = await loadMarketplaceCaseDims(admin);
  // Cross-org by design: density is a physical property with a public citation,
  // so a value sourced for one client is valid for every client's same material.
  const densities = await loadMaterialDensities(admin);

  const { openRows: quoteCasesOpen, resolvedRows: quoteCasesResolved, resolvedTotal: quoteCasesResolvedTotal } = await loadOrgCases(
    admin,
    org.id,
    assignmentCtx,
    ["quote"]
  );

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
            densities={densities}
            canAct={canAct}
            slug={org.slug}
            orgId={org.id}
            suppliers={supplierProfiles.map((p) => ({ id: p.supplier_id, name: p.supplier_name }))}
            supplierTypes={supplierTypes}
            supplierOperators={supplierOperators}
            currentUserName={assignmentCtx.pool.find((op) => op.id === session.userId)?.name ?? null}
            supplierDocs={supplierDocs}
            clientRules={clientRules}
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
              resolvedTotal={quoteCasesResolvedTotal}
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
