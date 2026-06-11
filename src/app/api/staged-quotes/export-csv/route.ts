import { NextResponse } from "next/server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds } from "@/lib/org-access";
import { toCsv } from "@/lib/csv";

// GET /api/staged-quotes/export-csv
// Streams a CSV of all approved staged_quotes the caller can see. Ops downloads
// this and uploads it to Tenkara via the existing bulk-upload path — staged
// quotes never write back automatically.

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
    .select(
      "supplier_id, supplier_name, material_id, material_name, price, case_size, unit_of_measurement, unit_price, currency, source, source_attachment_name, approved_at"
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
    "price",
    "case_size",
    "unit_of_measurement",
    "unit_price",
    "currency",
    "source",
    "source_file",
    "approved_at",
  ];
  const body = toCsv(
    headers,
    (rows ?? []).map((r: any) => [
      r.supplier_id,
      r.supplier_name,
      r.material_id,
      r.material_name,
      r.price,
      r.case_size,
      r.unit_of_measurement,
      r.unit_price,
      r.currency,
      r.source,
      r.source_attachment_name,
      r.approved_at,
    ])
  );

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="staged-quotes-${date}.csv"`,
    },
  });
}
