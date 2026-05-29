import type Anthropic from "@anthropic-ai/sdk";
import type { SessionContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds } from "@/lib/org-access";
import { resolveSupplierNames, resolveMaterialNames } from "@/lib/tenkara-names";

// Read-only tools for the Ops assistant. EVERY executor scopes its query to the
// caller's org access via getAssignedOrgIds(session) — null means a global role
// (see everything), an array means filter to exactly those org_ids, and an empty
// array means the user has no org access and must get no rows. This is the
// security boundary: the assistant must never surface another org's data.

const LEAD_STAGES = ["raw", "enriched", "ready_for_outreach", "ready_for_approval", "terminal"] as const;

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "list_my_orgs",
    description: "List the organizations the current user can access (id, name, slug). Use to know which orgs are in scope.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_my_assigned_drafts",
    description:
      "Get outreach drafts currently assigned to the current user and awaiting their review/send (status staged). Returns subject, org, supplier, material, and when it was staged.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_lead_counts_by_stage",
    description:
      "Get counts of active leads in the lead pipeline grouped by stage (raw, enriched, ready_for_outreach, ready_for_approval, terminal), scoped to the user's orgs.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_open_cases",
    description:
      "Get open/in-progress escalation cases (stale leads escalated by Agent 07) for the user's orgs, including type, recommended action, supplier, and org.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "find_leads",
    description:
      "Search leads in the pipeline, scoped to the user's orgs. Optionally filter by stage, material name (substring), or supplier name (substring). Returns up to 25 leads.",
    input_schema: {
      type: "object",
      properties: {
        stage: { type: "string", enum: LEAD_STAGES as unknown as string[], description: "Optional lead stage filter." },
        material: { type: "string", description: "Optional case-insensitive substring match on material name." },
        supplier: { type: "string", description: "Optional case-insensitive substring match on supplier name." },
      },
    },
  },
];

type ToolResult = unknown;

export async function runRunbookTool(
  name: string,
  input: Record<string, any>,
  session: SessionContext
): Promise<ToolResult> {
  const admin = createAdminClient();
  const assigned = await getAssignedOrgIds(session); // null = all orgs; [] = none
  const noAccess = Array.isArray(assigned) && assigned.length === 0;

  switch (name) {
    case "list_my_orgs": {
      if (noAccess) return { orgs: [] };
      let q = admin.from("orgs").select("id, slug, name").order("name");
      if (assigned) q = q.in("id", assigned);
      const { data } = await q;
      return { orgs: data ?? [] };
    }

    case "get_my_assigned_drafts": {
      // Inherently scoped to this user; org filter is a belt-and-suspenders extra.
      let q = admin
        .from("draft_references")
        .select("id, subject, supplier_id, material_id, created_at, org_id, orgs(name)")
        .eq("assigned_operator", session.userId)
        .eq("status", "staged")
        .order("created_at", { ascending: false })
        .limit(25);
      if (assigned) q = q.in("org_id", assigned);
      const { data } = await q;
      const rows = (data ?? []) as any[];
      const [supplierNames, materialNames] = await Promise.all([
        resolveSupplierNames(rows.map((r) => r.supplier_id).filter(Boolean)),
        resolveMaterialNames(rows.map((r) => r.material_id).filter(Boolean)),
      ]).catch(() => [new Map<string, string>(), new Map<string, string>()] as const);
      return {
        count: rows.length,
        drafts: rows.map((r) => ({
          subject: r.subject ?? "(no subject)",
          org: r.orgs?.name ?? null,
          supplier: r.supplier_id ? supplierNames.get(r.supplier_id) ?? null : null,
          material: r.material_id ? materialNames.get(r.material_id) ?? null : null,
          staged_at: r.created_at,
        })),
      };
    }

    case "get_lead_counts_by_stage": {
      if (noAccess) return { counts: {} };
      const counts: Record<string, number> = {};
      for (const stage of LEAD_STAGES) {
        let q = admin
          .from("leads_in_flight")
          .select("id", { count: "exact", head: true })
          .eq("stage", stage)
          .eq("status", "active");
        if (assigned) q = q.in("org_id", assigned);
        const { count } = await q;
        counts[stage] = count ?? 0;
      }
      return { counts };
    }

    case "get_open_cases": {
      if (noAccess) return { count: 0, cases: [] };
      let q = admin
        .from("cases")
        .select("id, supplier_id, type, recommended_action, status, created_at, org_id, orgs(name)")
        .in("status", ["open", "in_progress"])
        .order("created_at", { ascending: false })
        .limit(25);
      if (assigned) q = q.in("org_id", assigned);
      const { data } = await q;
      const rows = (data ?? []) as any[];
      const supplierNames = await resolveSupplierNames(rows.map((r) => r.supplier_id).filter(Boolean)).catch(
        () => new Map<string, string>()
      );
      return {
        count: rows.length,
        cases: rows.map((r) => ({
          org: r.orgs?.name ?? null,
          supplier: r.supplier_id ? supplierNames.get(r.supplier_id) ?? null : null,
          type: r.type,
          recommended_action: r.recommended_action,
          status: r.status,
          opened_at: r.created_at,
        })),
      };
    }

    case "find_leads": {
      if (noAccess) return { count: 0, leads: [] };
      let q = admin
        .from("leads_in_flight")
        .select("supplier_name, material_name, stage, status, source, confidence_score, payload, org_id, orgs(name)")
        .eq("status", "active")
        .order("confidence_score", { ascending: false, nullsFirst: false })
        .limit(25);
      if (assigned) q = q.in("org_id", assigned);
      if (typeof input.stage === "string" && (LEAD_STAGES as readonly string[]).includes(input.stage)) {
        q = q.eq("stage", input.stage);
      }
      if (typeof input.material === "string" && input.material.trim()) {
        q = q.ilike("material_name", `%${input.material.trim()}%`);
      }
      if (typeof input.supplier === "string" && input.supplier.trim()) {
        q = q.ilike("supplier_name", `%${input.supplier.trim()}%`);
      }
      const { data } = await q;
      const rows = (data ?? []) as any[];
      return {
        count: rows.length,
        leads: rows.map((r) => ({
          supplier: r.supplier_name,
          material: r.material_name,
          stage: r.stage,
          source: r.source,
          confidence: r.confidence_score != null ? Number(r.confidence_score) : null,
          pricing: r.payload?.pack_sizes_pricing ?? null,
          org: r.orgs?.name ?? null,
        })),
      };
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}
