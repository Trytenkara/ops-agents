import { tenkaraQuery } from "@/lib/tenkara-readonly";

// One row per (material × supplier) latest expiring/expired quote, across every org.
// Filters out:
//   - quotes where status is 'active' (a current, still-valid quote — nothing to
//     revalidate). Everything else past its reanalyze date is in scope, including
//     status 'expired': revalidation is exactly for expiring-soon/expired quotes.
//   - quotes with no supplier contact email, or a malformed one (junk like
//     'Online', a missing TLD, or two addresses crammed into one field)
//   - non-latest quotes for the same material/supplier pair
//
// Direct port of automations/workflows/quote_revalidation.py:query_overdue_rows.
export interface OverdueRow {
  quote_id: string;
  material_id: string;
  supplier_id: string;
  reanalyze: string;        // YYYY-MM-DD
  quote_date: string | null;
  price: number | null;
  lead_time_days: number | null;
  material_name: string;
  grade: any[] | null;
  supplier_name: string;
  supplier_contact_name: string | null;
  supplier_contact_email: string;
  client_org_id: string;
  client_org_name: string;
  client_purchasing_email: string | null;
  author_id: string | null;
  author_email: string | null;
  author_firstname: string | null;
  author_lastname: string | null;
  author_is_active_operator: boolean;
}

export async function queryOverdueRows(): Promise<OverdueRow[]> {
  const sql = `
    WITH ranked AS (
      SELECT
        mq.id AS quote_id,
        mq.material_id,
        mq.supplier_id,
        mq.reanalyze::date AS reanalyze,
        mq.quote_date::date AS quote_date,
        mq.price,
        mq.lead_time_days,
        m.name AS material_name,
        m.grade,
        s.name AS supplier_name,
        s.poc_name AS supplier_contact_name,
        s.poc_email AS supplier_contact_email,
        client_user.organization_id::text AS client_org_id,
        client_org.name AS client_org_name,
        client_org.connected_email->>'email' AS client_purchasing_email,
        qa.id AS author_id,
        qa.email AS author_email,
        qa.firstname AS author_firstname,
        qa.lastname AS author_lastname,
        (ov.email IS NOT NULL) AS author_is_active_operator,
        ROW_NUMBER() OVER (
          PARTITION BY mq.material_id, mq.supplier_id
          ORDER BY mq.created_at DESC
        ) AS rn
      FROM material_quotes mq
      JOIN materials m ON m.id = mq.material_id
      JOIN users client_user ON client_user.id = m.user_id
      JOIN organizations client_org ON client_org.id = client_user.organization_id
      JOIN suppliers s ON s.id = mq.supplier_id
      LEFT JOIN users qa ON qa.id = mq.user_id
      LEFT JOIN operators_view ov ON ov.email = qa.email
      WHERE
        (mq.status IS NULL OR mq.status::text <> 'active')
        AND mq.reanalyze < CURRENT_DATE + INTERVAL '7 days'
        AND s.poc_email IS NOT NULL
        AND s.poc_email <> ''
        -- Drop contacts whose poc_email isn't a single valid address
        -- (junk like 'Online', missing TLDs, or two addresses in one field).
        AND s.poc_email ~ '^[^@[:space:];,]+@[^@[:space:];,]+\.[^@[:space:];,]+$'
        -- Drop obvious test/placeholder supplier rows (e.g. 'test supplier').
        AND s.name !~* '^test'
        AND s.poc_email !~* '@(example|email|test)\.'
    )
    SELECT * FROM ranked WHERE rn = 1
    ORDER BY client_org_name, supplier_id, reanalyze
  `;
  return await tenkaraQuery<OverdueRow>(sql);
}

// Per-org audit: total managed materials + materials-with-an-active-quote.
// Used in the run summary so ops can see context-wide volume even when no
// drafts staged (e.g., heartbeat runs).
export interface OrgAudit {
  org_id: string;
  org_name: string;
  managed_materials: number;
  materials_with_active_quote: number;
}

export async function queryAudit(): Promise<OrgAudit[]> {
  const sql = `
    SELECT
      o.id::text AS org_id,
      o.name AS org_name,
      COUNT(DISTINCT m.id) AS managed_materials,
      COUNT(DISTINCT m.id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM material_quotes mq2
          WHERE mq2.material_id = m.id AND mq2.status = 'active'
        )
      ) AS materials_with_active_quote
    FROM organizations o
    LEFT JOIN users u ON u.organization_id = o.id
    LEFT JOIN materials m ON m.user_id = u.id
    GROUP BY o.id, o.name
    ORDER BY o.name
  `;
  return await tenkaraQuery<OrgAudit>(sql);
}
