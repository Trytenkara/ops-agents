import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAllPaged } from "@/lib/supabase-paging";
import { getClientSuppliers } from "@/lib/client-suppliers";
import {
  getOrgAssignmentContext,
  getOrgSupplierTypes,
  resolveOperatorId,
  supplierKind,
  leadAutoKey,
  type AssignmentConfig,
} from "@/lib/operator-assignment";
import type { MarketKind } from "@/lib/lead-market";

// Pin the CURRENT derived owner into supplier_assignment for every supplier that
// has no claim yet, so the auto spread's answer becomes the explicit one and the
// change about to be made is visually a no-op.
//
// Two callers need this. Switching to manual freezes everything, or the org comes
// back from the switch with its whole book unassigned. Narrowing
// assignment_supplier_types freezes only the kinds being DROPPED: those suppliers
// are about to fall out of the auto loop, and with nothing pinned they went
// straight to "Unassigned" across the validation pages (Sierra lost all 231
// aggregators that way). `kinds` = which market kinds to pin; null = all of them.
export async function freezeDerivedOwners(
  admin: SupabaseClient,
  orgId: string,
  actorUserId: string,
  kinds: MarketKind[] | null = null,
  // Replay support: pin what a PREVIOUS config would have derived, for a change
  // that already landed without pinning anything.
  configOverride: AssignmentConfig | null = null
): Promise<number> {
  const loaded = await getOrgAssignmentContext(admin, orgId);
  const ctx = configOverride ? { ...loaded, config: configOverride } : loaded;
  if (ctx.config.mode === "manual") return 0;

  // Resolve against the config still in force, so what gets pinned is exactly
  // what the page showed a moment ago.
  const restrict = kinds?.length ? new Set<MarketKind>(kinds) : null;
  const types = restrict ? await getOrgSupplierTypes(admin, orgId) : ctx.supplierTypes;
  const marketplaceOnly = new Set<string>();
  const kindOf = (id: string | null, name?: string | null): MarketKind | null =>
    supplierKind(types, id, name) ?? (id && marketplaceOnly.has(id) ? "marketplace" : null);
  const wanted = (id: string | null, name?: string | null) =>
    !restrict || restrict.has(kindOf(id, name) ?? "direct");

  const suppliers = new Map<string, string | null>();
  const collect = async (table: "leads_in_flight" | "draft_references", cols: string) => {
    const rows = await selectAllPaged<{ supplier_id: string | null; supplier_name?: string | null }>((from, to) =>
      admin.from(table).select(cols).eq("org_id", orgId).not("supplier_id", "is", null).order("supplier_id").range(from, to) as any
    ).catch(() => []);
    for (const r of rows) if (r.supplier_id) suppliers.set(r.supplier_id, r.supplier_name ?? suppliers.get(r.supplier_id) ?? null);
  };
  await collect("leads_in_flight", "supplier_id, supplier_name");
  await collect("draft_references", "supplier_id");

  // The Suppliers tab lists the client's Tenkara suppliers, including ones with
  // no lead yet. They show an auto owner today, so they get frozen too.
  const { data: org } = await admin.from("orgs").select("tenkara_org_id").eq("id", orgId).maybeSingle();
  const tenkaraSuppliers = await getClientSuppliers(org?.tenkara_org_id ?? null).catch(() => null);
  if (tenkaraSuppliers) {
    for (const s of [
      ...tenkaraSuppliers.approved,
      ...tenkaraSuppliers.pending_review,
      ...tenkaraSuppliers.denied,
      ...tenkaraSuppliers.draft,
    ]) {
      suppliers.set(s.id, s.name ?? suppliers.get(s.id) ?? null);
      // Tenkara's own flag is the fallback when neither a lead nor a profile
      // classified this supplier. It can't tell aggregator from direct, so it
      // only ever settles the marketplace question.
      if (s.is_marketplace && !kindOf(s.id, s.name)) marketplaceOnly.add(s.id);
    }
  }

  const claims = [...suppliers]
    .filter(([sid, name]) => !ctx.manual.has(sid) && wanted(sid, name))
    .map(([sid, name]) => ({ supplier_id: sid, operator_id: resolveOperatorId(ctx, sid, kindOf(sid, name)) }))
    .filter((r): r is { supplier_id: string; operator_id: string } => !!r.operator_id);

  let frozen = 0;
  for (let i = 0; i < claims.length; i += 500) {
    const chunk = claims.slice(i, i + 500).map((c) => ({
      supplier_id: c.supplier_id,
      org_id: orgId,
      operator_id: c.operator_id,
      assigned_by: actorUserId,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await admin
      .from("supplier_assignment")
      .upsert(chunk, { onConflict: "supplier_id,org_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    frozen += chunk.length;
  }

  // Scout leads carry their operator on the lead, not on a supplier, so they need
  // the same treatment or their outreach falls back to the org's primary. Grouped
  // by operator to keep this a handful of updates instead of one per lead.
  const scout = await selectAllPaged<{ id: string; email: string | null; supplier_name: string | null }>((from, to) =>
    admin
      .from("leads_in_flight")
      .select("id, supplier_name, email:payload->>supplier_contact_email")
      .eq("org_id", orgId)
      .eq("status", "active")
      .is("supplier_id", null)
      .is("assigned_operator_id", null)
      .order("id")
      .range(from, to)
  ).catch(() => []);
  const byOperator = new Map<string, string[]>();
  for (const l of scout) {
    // Same key outreach uses, so the frozen owner matches who was getting drafts.
    const key = leadAutoKey({ supplierName: l.supplier_name, email: l.email, leadId: l.id });
    if (!wanted(key, l.supplier_name)) continue;
    const opId = resolveOperatorId(ctx, key, kindOf(key, l.supplier_name));
    if (!opId) continue;
    const ids = byOperator.get(opId) ?? [];
    ids.push(l.id);
    byOperator.set(opId, ids);
  }
  for (const [opId, ids] of byOperator) {
    for (let i = 0; i < ids.length; i += 500) {
      const { error } = await admin
        .from("leads_in_flight")
        .update({ assigned_operator_id: opId, updated_at: new Date().toISOString() })
        .in("id", ids.slice(i, i + 500));
      if (error) throw new Error(error.message);
      frozen += Math.min(500, ids.length - i);
    }
  }

  return frozen;
}
