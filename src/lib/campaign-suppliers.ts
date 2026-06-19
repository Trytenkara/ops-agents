import { tenkaraQuery } from "@/lib/tenkara-readonly";

// Per-campaign supplier relay for the material-page "vendors validating" state.
// Buckets suppliers into the lifecycle:
//   discovered -> being_validated -> approved -> active, plus archived (denied).
//
//   discovered      surfaced by the agent's trace, not yet in the supplier DB
//   being_validated in DB, approval = draft | pending_review
//   approved        approval = approved, but not yet qualified for this client
//   active          approved AND is_qualified[org] = true (qualified for client)
//   archived        approval = denied
//
// Two data sources:
//   prod (default) — Tenkara prod via the read-only tenkaraQuery (pg, mcp_readonly)
//   dev            — Tenkara dev via the Supabase REST API (test data; has the
//                    discovery campaigns that prod doesn't have yet)

export type Group = "discovered" | "being_validated" | "approved" | "active" | "archived";
export type Source = "prod" | "dev";
export const CAMPAIGN_GROUPS: Group[] = ["discovered", "being_validated", "approved", "active", "archived"];
export const ORG_GROUPS: Group[] = ["being_validated", "approved", "active", "archived"];

export function resolveSource(raw: string | null | undefined): Source {
  return raw === "dev" ? "dev" : "prod";
}

interface SupplierRow {
  id: string;
  name: string;
  website: string | null;
  poc_name: string | null;
  poc_email: string | null;
  city: string | null;
  state: string | null;
  approval: string;
  is_qualified: Record<string, boolean> | null;
  organization_ids: string[] | null;
  updated_at: string;
}

const SUPPLIER_COLS =
  "id, name, website, poc_name, poc_email, city, state, approval, is_qualified, organization_ids, updated_at";
const SUPPLIER_COLS_REST = SUPPLIER_COLS.replace(/\s/g, "");
const SCANJOB_COLS = "id, organization_id, type, status, input, items_total, items_completed, created_at, completed_at";
const SCANJOB_COLS_REST = SCANJOB_COLS.replace(/\s/g, "");

// --- dev: Supabase REST ---
async function devRest(path: string): Promise<any[]> {
  const url = process.env.SUPABASE_DEV_URL;
  const key = process.env.SUPABASE_DEV_SERVICE_KEY;
  if (!url || !key) throw new Error("dev source not configured (SUPABASE_DEV_URL / SUPABASE_DEV_SERVICE_KEY)");
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`supabase dev ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- data access: branch on source, return identical row shapes ---
async function qScanJobs(source: Source, orgId?: string): Promise<any[]> {
  if (source === "dev") {
    const f = orgId ? `&organization_id=eq.${orgId}` : "";
    return devRest(`scan_jobs?select=${SCANJOB_COLS_REST}&order=created_at.desc${f}`);
  }
  return orgId
    ? tenkaraQuery(`select ${SCANJOB_COLS} from scan_jobs where organization_id = $1 order by created_at desc`, [orgId])
    : tenkaraQuery(`select ${SCANJOB_COLS} from scan_jobs order by created_at desc`);
}

async function qScanJobById(source: Source, id: string): Promise<any | null> {
  if (source === "dev") {
    const rows = await devRest(`scan_jobs?id=eq.${id}&select=${SCANJOB_COLS_REST}`);
    return rows[0] ?? null;
  }
  const rows = await tenkaraQuery(`select ${SCANJOB_COLS} from scan_jobs where id = $1`, [id]);
  return rows[0] ?? null;
}

async function qScansByJob(source: Source, jobId: string): Promise<any[]> {
  if (source === "dev") {
    return devRest(`manufacturer_scans?job_id=eq.${jobId}&select=supplier_source,status,input,result`);
  }
  return tenkaraQuery(`select supplier_source, status, input, result from manufacturer_scans where job_id = $1`, [jobId]);
}

async function qSuppliersByOrg(source: Source, orgId: string): Promise<SupplierRow[]> {
  if (source === "dev") {
    return devRest(`suppliers?organization_ids=cs.{${orgId}}&select=${SUPPLIER_COLS_REST}`) as Promise<SupplierRow[]>;
  }
  return tenkaraQuery(`select ${SUPPLIER_COLS} from suppliers where $1 = any(organization_ids)`, [orgId]) as Promise<SupplierRow[]>;
}

// --- grouping ---
export function groupFor(s: SupplierRow, orgId: string | null): Group {
  if (s.approval === "denied") return "archived";
  if (s.approval === "approved") {
    const qualified = !!(orgId && s.is_qualified && s.is_qualified[orgId]);
    return qualified ? "active" : "approved";
  }
  return "being_validated";
}

function normalize(name: string): string {
  return (name || "")
    .toLowerCase()
    .replace(/[.,&]/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|sons|group|sa|sac|sl|gmbh)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface TraceCompany {
  name: string;
  domain: string | null;
  country: string | null;
  lead_type: string | null;
  trust_tier: string | null;
  source_urls: string[];
  material_name: string | null;
}

function collectTraceCompanies(node: any, material: string, out: TraceCompany[], seen: Set<string>) {
  if (!node || typeof node !== "object") return;
  if (node.companyName) {
    const key = normalize(node.companyName) + "|" + (node.domain || "");
    if (!seen.has(key)) {
      seen.add(key);
      out.push({
        name: node.companyName,
        domain: node.domain || null,
        country: node.country || null,
        lead_type: node.leadType || null,
        trust_tier: node.trustTier || null,
        source_urls: node.sourceUrls || [],
        material_name: material || null,
      });
    }
  }
  for (const child of node.children || []) collectTraceCompanies(child, material, out, seen);
}

function supplierObject(s: SupplierRow, orgId: string | null, group: Group, extra: Record<string, any> = {}) {
  const qualified = orgId && s.is_qualified ? !!s.is_qualified[orgId] : null;
  const location = [s.city, s.state].filter(Boolean).join(", ") || null;
  return {
    supplier_id: s.id,
    name: s.name,
    website: s.website || null,
    poc_name: (s.poc_name || "").split(";")[0]?.trim() || null,
    poc_email: (s.poc_email || "").split(";")[0]?.trim() || null,
    location,
    group,
    approval: s.approval,
    qualified,
    source: "uploaded",
    updated_at: s.updated_at,
    ...extra,
  };
}

function materialsOf(input: any): string[] {
  return (input?.distributors || [])
    .map((d: any) => d.materialFilter)
    .filter((m: string, i: number, a: string[]) => m && a.indexOf(m) === i);
}

// --- public API ---
export async function listCampaigns(source: Source, orgId?: string) {
  const rows = await qScanJobs(source, orgId);
  return rows.map((j: any) => ({
    campaign_id: j.id,
    org_id: j.organization_id,
    type: j.type,
    status: j.status,
    materials: materialsOf(j.input),
    items_total: j.items_total,
    items_completed: j.items_completed,
    created_at: j.created_at,
    completed_at: j.completed_at,
  }));
}

export async function getCampaignSuppliers(source: Source, scanJobId: string) {
  const job = await qScanJobById(source, scanJobId);
  if (!job) return null;
  const orgId: string = job.organization_id;

  const scans = await qScansByJob(source, scanJobId);

  const discovered: TraceCompany[] = [];
  const seen = new Set<string>();
  for (const scan of scans) {
    const material = scan?.input?.materialFilter || "";
    for (const r of scan?.result?.trace?.results || []) {
      if (r?.trace?.root) collectTraceCompanies(r.trace.root, material, discovered, seen);
    }
  }

  const orgSuppliers = await qSuppliersByOrg(source, orgId);
  const byName = new Map<string, SupplierRow>();
  for (const s of orgSuppliers) byName.set(normalize(s.name), s);

  const groups: Record<Group, any[]> = {
    discovered: [], being_validated: [], approved: [], active: [], archived: [],
  };

  for (const c of discovered) {
    const match = byName.get(normalize(c.name));
    if (match) {
      const grp = groupFor(match, orgId);
      groups[grp].push(
        supplierObject(match, orgId, grp, {
          source: "discovered",
          material_name: c.material_name,
          domain: c.domain,
          lead_type: c.lead_type,
          trust_tier: c.trust_tier,
          source_urls: c.source_urls,
        })
      );
    } else {
      groups.discovered.push({
        supplier_id: null,
        name: c.name,
        website: c.domain ? `https://${c.domain}` : null,
        poc_name: null,
        poc_email: null,
        location: c.country,
        group: "discovered" as Group,
        approval: null,
        qualified: null,
        source: "discovered",
        material_name: c.material_name,
        lead_type: c.lead_type,
        trust_tier: c.trust_tier,
        source_urls: c.source_urls,
        updated_at: null,
      });
    }
  }

  return {
    campaign_id: job.id,
    org_id: orgId,
    type: job.type,
    status: job.status,
    materials: materialsOf(job.input),
    items_total: job.items_total,
    items_completed: job.items_completed,
    created_at: job.created_at,
    completed_at: job.completed_at,
    counts: Object.fromEntries(CAMPAIGN_GROUPS.map((k) => [k, groups[k].length])),
    groups,
  };
}

export async function getOrgSuppliers(source: Source, orgId: string) {
  const list = await qSuppliersByOrg(source, orgId);
  const groups: Record<string, any[]> = { being_validated: [], approved: [], active: [], archived: [] };
  for (const s of list) {
    const grp = groupFor(s, orgId);
    groups[grp].push(supplierObject(s, orgId, grp));
  }
  return {
    org_id: orgId,
    counts: Object.fromEntries(ORG_GROUPS.map((k) => [k, groups[k].length])),
    groups,
  };
}
