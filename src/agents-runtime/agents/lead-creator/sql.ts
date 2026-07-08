import { tenkaraQuery } from "@/lib/tenkara-readonly";

// Tenkara prod schema (confirmed via mcp_readonly):
//   materials(id, name, trade_name, inci, created_at, user_id, ...)
//   suppliers(id, name, website, poc_name, poc_email, country, ...)
//   material_quotes(id, material_id, supplier_id, created_at, status, ...)
//   supplier_catalog_materials(supplier_id, product_name, trade_name, inci, cas_number, ...)
//
// Agent 03 reads ONLY from Tenkara via mcp_readonly. No writes touch this DB.

export interface MaterialRow {
  id: string;
  name: string | null;
  trade_name: string | null;
  inci: string | null;
  created_at: string;
  user_id: string | null;
  // Tenkara organization the material belongs to (resolved via users.organization_id).
  // The agent maps this to an OA org_id through orgs.tenkara_org_id before insert.
  tenkara_org_id: string | null;
}

export interface CandidateSupplier {
  supplier_id: string;
  supplier_name: string;
  supplier_website: string | null;
  supplier_poc_name: string | null;
  supplier_poc_email: string | null;
  supplier_country: string | null;
  // How we found them — drives `source` and `confidence_score` downstream.
  signal: "quoted_same_material" | "quoted_similar_inci" | "quoted_similar_name" | "catalog_match";
  signal_count: number;
}

// Materials added since `since` (ISO). Spec says last 4h on cron; pass since
// explicitly so manual triggers can backfill.
export async function queryRecentMaterials(since: string): Promise<MaterialRow[]> {
  return tenkaraQuery<MaterialRow>(
    `select m.id,
            m.name,
            m.trade_name,
            m.inci,
            m.created_at,
            m.user_id,
            u.organization_id as tenkara_org_id
       from public.materials m
       left join public.users u on u.id = m.user_id
      where m.created_at >= $1::timestamptz
      order by m.created_at desc
      limit 200`,
    [since]
  );
}

// Fetch specific materials by id (for an on-demand single-material discovery
// run triggered from the dashboard, ignoring the recency window).
export async function queryMaterialsByIds(ids: string[]): Promise<MaterialRow[]> {
  if (!ids.length) return [];
  return tenkaraQuery<MaterialRow>(
    `select m.id, m.name, m.trade_name, m.inci, m.created_at, m.user_id,
            u.organization_id as tenkara_org_id
       from public.materials m
       left join public.users u on u.id = m.user_id
      where m.id = any($1::uuid[])`,
    [ids]
  );
}

// Top suppliers who have quoted this exact material, then suppliers who have
// quoted other materials with matching INCI or name, then suppliers carrying
// the material in their uploaded catalog. We union the three buckets in JS
// (with signal labels) so Agent 03 can score and dedupe.
export async function findCandidatesForMaterial(material: MaterialRow): Promise<CandidateSupplier[]> {
  const candidates: CandidateSupplier[] = [];

  // 1. Suppliers who have quoted this exact material_id.
  const exact = await tenkaraQuery<CandidateSupplier>(
    `select s.id as supplier_id,
            s.name as supplier_name,
            s.website as supplier_website,
            s.poc_name as supplier_poc_name,
            s.poc_email as supplier_poc_email,
            s.country as supplier_country,
            'quoted_same_material'::text as signal,
            count(q.id)::int as signal_count
       from public.material_quotes q
       join public.suppliers s on s.id = q.supplier_id
      where q.material_id = $1
      group by s.id, s.name, s.website, s.poc_name, s.poc_email, s.country
      order by count(q.id) desc
      limit 5`,
    [material.id]
  );
  candidates.push(...exact);

  // 2. Suppliers who have quoted materials with matching INCI.
  if (material.inci) {
    const sameInci = await tenkaraQuery<CandidateSupplier>(
      `select s.id as supplier_id,
              s.name as supplier_name,
              s.website as supplier_website,
              s.poc_name as supplier_poc_name,
              s.poc_email as supplier_poc_email,
              s.country as supplier_country,
              'quoted_similar_inci'::text as signal,
              count(q.id)::int as signal_count
         from public.material_quotes q
         join public.suppliers s on s.id = q.supplier_id
         join public.materials  m2 on m2.id = q.material_id
        where m2.id <> $1
          and m2.inci is not null
          and lower(m2.inci) = lower($2)
        group by s.id, s.name, s.website, s.poc_name, s.poc_email, s.country
        order by count(q.id) desc
        limit 5`,
      [material.id, material.inci]
    );
    candidates.push(...sameInci);
  }

  // 3. Suppliers who have quoted materials with matching name (case-insensitive).
  const nameKey = material.trade_name ?? material.name;
  if (nameKey) {
    const sameName = await tenkaraQuery<CandidateSupplier>(
      `select s.id as supplier_id,
              s.name as supplier_name,
              s.website as supplier_website,
              s.poc_name as supplier_poc_name,
              s.poc_email as supplier_poc_email,
              s.country as supplier_country,
              'quoted_similar_name'::text as signal,
              count(q.id)::int as signal_count
         from public.material_quotes q
         join public.suppliers s on s.id = q.supplier_id
         join public.materials  m2 on m2.id = q.material_id
        where m2.id <> $1
          and (lower(coalesce(m2.trade_name,'')) = lower($2) or lower(coalesce(m2.name,'')) = lower($2))
        group by s.id, s.name, s.website, s.poc_name, s.poc_email, s.country
        order by count(q.id) desc
        limit 5`,
      [material.id, nameKey]
    );
    candidates.push(...sameName);
  }

  // 4. Suppliers with this material (by INCI/name) in their uploaded catalog.
  if (material.inci || nameKey) {
    const catalog = await tenkaraQuery<CandidateSupplier>(
      `select s.id as supplier_id,
              s.name as supplier_name,
              s.website as supplier_website,
              s.poc_name as supplier_poc_name,
              s.poc_email as supplier_poc_email,
              s.country as supplier_country,
              'catalog_match'::text as signal,
              count(scm.id)::int as signal_count
         from public.supplier_catalog_materials scm
         join public.suppliers s on s.id = scm.supplier_id
        where ($1::text is not null and lower(scm.inci) = lower($1::text))
           or ($2::text is not null and (
               lower(coalesce(scm.product_name,'')) = lower($2::text)
            or lower(coalesce(scm.trade_name,''))   = lower($2::text)
           ))
        group by s.id, s.name, s.website, s.poc_name, s.poc_email, s.country
        order by count(scm.id) desc
        limit 5`,
      [material.inci, nameKey]
    );
    candidates.push(...catalog);
  }

  return candidates;
}

// Saved quotes we already have for a material — Ben's recco: surface what's
// already in the quotes DB so the scanner shows existing coverage instead of
// re-sourcing it. Read-only; resolves supplier names in SQL.
export interface ExistingQuote {
  quote_id: string;
  material_id: string;
  material_name: string | null;
  supplier_name: string | null;
  price: number | null;
  uom: string | null;
  lead_time_days: number | null;
  status: string | null;
  quote_date: string | null;
  product_url: string | null;
}

const EXISTING_QUOTE_SELECT = `
  select q.id::text          as quote_id,
         q.material_id::text  as material_id,
         m.name               as material_name,
         s.name               as supplier_name,
         q.price              as price,
         q.unit_of_measurement as uom,
         q.lead_time_days     as lead_time_days,
         q.status::text       as status,
         q.quote_date::text   as quote_date,
         q.product_url        as product_url
    from public.material_quotes q
    join public.materials m on m.id = q.material_id
    left join public.suppliers s on s.id = q.supplier_id`;

// Existing quotes for a set of materials (used to annotate Agent 03's CSV).
export async function existingQuotesForMaterials(materialIds: string[]): Promise<ExistingQuote[]> {
  const ids = Array.from(new Set(materialIds.filter(Boolean)));
  if (ids.length === 0) return [];
  return tenkaraQuery<ExistingQuote>(
    `${EXISTING_QUOTE_SELECT}
      where q.material_id = any($1::uuid[]) and q.price is not null
      order by m.name, q.quote_date desc nulls last`,
    [ids]
  );
}

// Existing quotes across all materials owned by a Tenkara org (used on the
// per-org Leads tab). Materials link to an org via users.organization_id.
export async function existingQuotesForOrg(tenkaraOrgId: string, limit = 200): Promise<ExistingQuote[]> {
  return tenkaraQuery<ExistingQuote>(
    `${EXISTING_QUOTE_SELECT}
      left join public.users u on u.id = q.user_id
      where u.organization_id = $1::uuid and q.price is not null
      order by m.name, q.quote_date desc nulls last
      limit $2`,
    [tenkaraOrgId, limit]
  );
}
