import { NextResponse } from "next/server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds } from "@/lib/org-access";
import { toCsv } from "@/lib/csv";
import { QUOTE_TEMPLATE_HEADERS } from "@/lib/tenkara-templates";
import { correctMaterialSpelling } from "@/lib/material-spelling";

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
    .select("supplier_id, supplier_name, material_id, material_name, price, case_size, unit_of_measurement")
    .eq("status", "approved")
    .order("approved_at", { ascending: false });
  if (assigned) q = q.in("org_id", assigned);

  const { data: rows, error } = await q;
  if (error) return new NextResponse(error.message, { status: 500 });

  // Map each row to the full template column set; data we have is filled, the
  // rest stay blank for ops to complete before upload.
  const body = toCsv(
    [...QUOTE_TEMPLATE_HEADERS],
    (rows ?? []).map((r: any) =>
      QUOTE_TEMPLATE_HEADERS.map((col) =>
        col === "material_name" ? correctMaterialSpelling(r[col] ?? "") : r[col] != null ? r[col] : ""
      )
    )
  );

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tenkara-quotes-${date}.csv"`,
    },
  });
}
