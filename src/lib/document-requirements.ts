import type { createAdminClient } from "@/lib/supabase/admin";
import { getClientRequirements } from "@/lib/tenkara-requirements";
import { selectAllPaged } from "@/lib/supabase-paging";

// Tick a quote profile's pre-order document requirements from the documents we
// actually hold. Those checkboxes were operator-toggled and nothing wrote them,
// so a supplier could send the CoA, we could parse its lot and assay, and the
// bench would still report the requirement unmet until someone clicked.
//
// Fill-only, and one-directional: false -> true only. An operator may have
// ticked a box from a document that never reached us (seen on a call, held in
// another system), and clearing that would be destroying their work with a
// guess. Un-ticking stays manual.

type Admin = ReturnType<typeof createAdminClient>;

const DOC_TYPE_TO_MET: Record<string, string> = {
  coa: "preorder_coa_met",
  sds: "preorder_sds_met",
  tds: "preorder_tds_met",
};

const normName = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

// Null when the row identifies no supplier at all. Without this guard both sides
// key on the literal string "name:" and every nameless document matches every
// nameless quote: 12 unattributed documents (product catalogues, an image001.png)
// ticked CoA on 2 quotes that have no supplier.
function supKey(id: string | null | undefined, name: string | null | undefined): string | null {
  if (id) return id;
  const n = normName(name);
  return n ? `name:${n}` : null;
}

// A CoA, SDS or TDS describes ONE product, so the match has to include the
// material. Keying on supplier alone made a Lotioncrafter SDS for one material
// tick "SDS met" on its Black Pepper, Jojoba Oil and Isopropyl Myristate quotes
// too: 22 of 46 ticks were for a material we hold no document for.
function matchKey(
  row: { supplier_id: string | null; supplier_name: string | null; material_id: string | null }
): string | null {
  const sup = supKey(row.supplier_id, row.supplier_name);
  return sup && row.material_id ? `${sup}|m:${row.material_id}` : null;
}

export async function syncDocRequirementsMet(admin: Admin, orgId: string): Promise<{ updated: number }> {
  // Whether a document is required is the CLIENT's rule, held in Tenkara. This
  // used to gate on quote_profiles.preorder_*_required, which nothing ever wrote:
  // false on all 939 live rows, so this function could never tick anything while
  // McGinley's real settings make CoA, SDS and TDS hard dealbreakers. If the
  // Tenkara read fails we fall back to the local column rather than ticking
  // requirements the client never asked for.
  const { data: orgRow } = await admin.from("orgs").select("tenkara_org_id").eq("id", orgId).maybeSingle();
  const items = await getClientRequirements((orgRow as any)?.tenkara_org_id).catch(() => []);
  const clientRequires = new Set(items.filter((i) => i.phase === "pre_order" && i.requested).map((i) => i.key));

  // supplier_issued=false is a third-party reference sheet scraped off the web.
  // It is real chemistry but it is not this vendor issuing a document, so it
  // cannot satisfy a client requirement. Null (every pre-0078 row) counts.
  // PERS-06: this is a completeness check, so a window is the wrong shape for
  // it entirely — a document past the cap is invisible and the supplier is
  // re-asked for a CoA we already hold. Both sides page to the end, over the
  // primary key so the order is stable between pages.
  const docs = await selectAllPaged<any>((from, to) =>
    admin
      .from("supplier_documents")
      .select("supplier_id, supplier_name, material_id, doc_type, supplier_issued")
      .eq("org_id", orgId)
      .in("doc_type", Object.keys(DOC_TYPE_TO_MET))
      .order("id")
      .range(from, to)
  );

  const held = new Map<string, Set<string>>();
  for (const d of docs) {
    if (d.supplier_issued === false) continue;
    const k = matchKey(d);
    if (!k) continue;
    if (!held.has(k)) held.set(k, new Set());
    held.get(k)!.add(d.doc_type);
  }
  if (!held.size) return { updated: 0 };

  const profiles = await selectAllPaged<any>((from, to) =>
    admin
      .from("quote_profiles")
      .select(
        "id, supplier_id, supplier_name, material_id, preorder_coa_required, preorder_sds_required, preorder_tds_required, preorder_coa_met, preorder_sds_met, preorder_tds_met"
      )
      .eq("org_id", orgId)
      .order("id")
      .range(from, to)
  );

  let updated = 0;
  for (const p of profiles) {
    const pKey = matchKey(p);
    const types = pKey ? held.get(pKey) : undefined;
    if (!types) continue;

    const patch: Record<string, boolean> = {};
    for (const [docType, metCol] of Object.entries(DOC_TYPE_TO_MET)) {
      const reqCol = metCol.replace("_met", "_required");
      // Only a requirement the client actually asked for. Ticking "met" on
      // something never required would read as a decision nobody made.
      if (!clientRequires.has(docType) && !p[reqCol]) continue;
      if (p[metCol]) continue;
      if (types.has(docType)) patch[metCol] = true;
    }
    if (!Object.keys(patch).length) continue;

    const { error } = await admin.from("quote_profiles").update(patch).eq("id", p.id);
    if (!error) updated++;
  }
  return { updated };
}
