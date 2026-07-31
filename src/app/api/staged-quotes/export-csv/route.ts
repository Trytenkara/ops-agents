import { NextResponse } from "next/server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds } from "@/lib/org-access";
import { toCsv } from "@/lib/csv";
import { QUOTE_TEMPLATE_HEADERS } from "@/lib/tenkara-templates";
import { correctMaterialSpelling } from "@/lib/material-spelling";
import { resolveSupplierIdByName } from "@/lib/supplier-profiles";

// GET /api/staged-quotes/export-csv
// Streams a Tenkara-ready CSV of all approved staged_quotes the caller can see,
// IN THE FULL BULK-UPLOAD TEMPLATE FORMAT — the columns we have data for are
// filled, the rest are left blank for ops to complete. This doubles as the
// template, so there's no separate blank-template download. All emitted columns
// are real Tenkara material_quotes columns. Ops uploads via Tenkara's bulk path;
// staged quotes never write back automatically.

export async function GET() {
  const session = await getSession();
  if (!session) return new NextResponse("unauthorized", { status: 401 });
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const admin = createAdminClient();
  const assigned = await getAssignedOrgIds(session);

  let q = admin
    .from("staged_quotes")
    .select("org_id, supplier_id, supplier_name, material_id, material_name, price, case_size, unit_of_measurement, case_type, case_dimensions")
    .eq("status", "approved")
    .order("approved_at", { ascending: false });
  if (assigned) q = q.in("org_id", assigned);

  const { data: rows, error } = await q;
  if (error) return new NextResponse(error.message, { status: 500 });

  // Backfill supplier_id where it's null by looking up supplier_name in
  // supplier_profiles. This resolves the name-only → supplier_id link so CSV
  // exports can include the ID for Tenkara bulk-upload.
  const orgIdsByName = new Map<string, Map<string, string | null>>();
  for (const row of rows ?? []) {
    if (row.supplier_id || !row.supplier_name) continue;
    if (!row.org_id) continue;

    if (!orgIdsByName.has(row.org_id)) {
      orgIdsByName.set(row.org_id, new Map());
    }
    const nameMap = orgIdsByName.get(row.org_id)!;
    const nameKey = row.supplier_name.trim().toLowerCase();
    if (!nameMap.has(nameKey)) {
      const resolved = await resolveSupplierIdByName(admin, row.org_id, row.supplier_name);
      nameMap.set(nameKey, resolved);
    }
    const resolvedId = nameMap.get(nameKey);
    if (resolvedId) {
      row.supplier_id = resolvedId;
    }
  }

  // Map each row to the full template column set; data we have is filled, the
  // rest stay blank for ops to complete before upload. The case_* dimension
  // columns are unpacked from the stored case_dimensions jsonb
  // ({unit, width, height, length, packaging_case_weight}).
  const body = toCsv(
    [...QUOTE_TEMPLATE_HEADERS],
    (rows ?? []).map((r: any) => {
      const d = r.case_dimensions ?? {};
      const dim: Record<string, any> = {
        case_weight: d.packaging_case_weight,
        case_width: d.width,
        case_height: d.height,
        case_length: d.length,
      };
      return QUOTE_TEMPLATE_HEADERS.map((col) =>
        col === "material_name"
          ? correctMaterialSpelling(r[col] ?? "")
          : col in dim
            ? dim[col] != null ? dim[col] : ""
            : r[col] != null ? r[col] : ""
      );
    })
  );

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tenkara-quotes-${date}.csv"`,
    },
  });
}
