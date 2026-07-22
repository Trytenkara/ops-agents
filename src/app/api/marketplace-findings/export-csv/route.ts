import { NextResponse } from "next/server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds } from "@/lib/org-access";
import { toCsv, type CsvCell } from "@/lib/csv";
import { correctMaterialSpelling } from "@/lib/material-spelling";

// GET /api/marketplace-findings/export-csv
// Streams a CSV of all approved marketplace_check_findings the caller can see,
// filename marketplace-price-updates-{YYYY-MM-DD}.csv.
// Ops downloads this and uploads to Tenkara via the existing bulk upload path —
// findings never write back automatically.

export async function GET() {
  const session = await getSession();
  if (!session) return new NextResponse("unauthorized", { status: 401 });
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const admin = createAdminClient();
  const assigned = await getAssignedOrgIds(session);

  let q = admin
    .from("marketplace_check_findings")
    .select(
      "supplier_id, supplier_name, material_id, material_name, current_price, currency, source_url, approved_by, approved_at"
    )
    .eq("status", "approved")
    .order("approved_at", { ascending: false });
  if (assigned) q = q.in("org_id", assigned);

  const { data: rows, error } = await q;
  if (error) return new NextResponse(error.message, { status: 500 });

  const headers = [
    "supplier_id",
    "supplier_name",
    "material_id",
    "material_name",
    "new_price",
    "currency",
    "source_url",
    "approved_by",
    "approved_at",
  ];
  const body = toCsv(
    headers,
    (rows ?? []).map((r: any) => [
      r.supplier_id,
      r.supplier_name,
      r.material_id,
      correctMaterialSpelling(r.material_name),
      r.current_price,
      r.currency,
      r.source_url,
      r.approved_by,
      r.approved_at,
    ] as CsvCell[])
  );

  const iso = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="marketplace-price-updates-${iso}.csv"`,
      "cache-control": "no-store",
    },
  });
}
