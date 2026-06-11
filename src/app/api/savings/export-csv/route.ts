import { NextRequest, NextResponse } from "next/server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { toCsv } from "@/lib/csv";
import { buildSavingsReport, savingsCsvRows, SAVINGS_CSV_HEADERS } from "@/lib/savings-report";

// GET /api/savings/export-csv?org=<slug>
// Client-facing per-material savings report: their accepted price vs the
// cheapest current Tenkara quote. Read-only on Tenkara.

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return new NextResponse("unauthorized", { status: 401 });
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const slug = req.nextUrl.searchParams.get("org");
  if (!slug) return new NextResponse("missing org", { status: 400 });

  const admin = createAdminClient();
  const { data: org } = await admin
    .from("orgs")
    .select("id, slug, tenkara_org_id")
    .eq("slug", slug)
    .maybeSingle();
  if (!org) return new NextResponse("org not found", { status: 404 });
  if (!org.tenkara_org_id) return new NextResponse("org not linked to Tenkara", { status: 400 });

  const report = await buildSavingsReport(org.tenkara_org_id, { onlyWithSavings: true });
  const body = toCsv([...SAVINGS_CSV_HEADERS], savingsCsvRows(report));

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="savings-${org.slug}-${date}.csv"`,
    },
  });
}
