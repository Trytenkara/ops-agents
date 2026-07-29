import { NextRequest, NextResponse } from "next/server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds } from "@/lib/org-access";
import { toCsv, type CsvCell } from "@/lib/csv";
import { correctMaterialSpelling } from "@/lib/material-spelling";
import { loadMarketplaceCaseDims, resolveCaseDims } from "@/lib/marketplace-case-dims";
import { tierBreakdown } from "@/lib/price-tiers";

// GET /api/leads-in-flight/marketplace-pricing-csv?org=<slug>
// Exports marketplace-tab leads (site_type M/MS) as one row per price tier.
// Ops use this to build / update the manual supplier-sourcing index.

const SITE_TYPE_LABEL: Record<string, string> = {
  M: "Open checkout",
  MS: "Checkout after signup",
};

const PULL_STATUS_LABEL: Record<string, string> = {
  pulled: "Auto-pulled",
  needs_manual_pull: "Needs manual pull",
  pending: "Pending",
};

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return new NextResponse("unauthorized", { status: 401 });
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  const orgSlug = (sp.get("org") ?? "").trim();

  const admin = createAdminClient();
  const assigned = await getAssignedOrgIds(session);

  let selectedOrgId: string | null = null;
  if (orgSlug) {
    const { data: orgRow } = await admin.from("orgs").select("id, slug, name").eq("slug", orgSlug).maybeSingle();
    if (orgRow) {
      if (assigned && !assigned.includes(orgRow.id)) {
        return new NextResponse("forbidden", { status: 403 });
      }
      selectedOrgId = orgRow.id;
    }
  }

  const buildQuery = () => {
    let q = admin
      .from("leads_in_flight")
      .select("id, supplier_name, material_name, source, payload, created_at, orgs(slug, name)")
      .eq("status", "active")
      .in("payload->>site_type", ["M", "MS"])
      .order("supplier_name", { ascending: true })
      .order("material_name", { ascending: true });
    if (selectedOrgId) q = q.eq("org_id", selectedOrgId);
    else if (assigned) q = q.in("org_id", assigned);
    return q;
  };

  const PAGE = 1000;
  const HARD_CAP = 50000;
  const rows: any[] = [];
  for (let from = 0; from < HARD_CAP; from += PAGE) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) return new NextResponse(error.message, { status: 500 });
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  const headers = [
    "supplier_name",
    "material_name",
    "source_url",
    "site_type",
    "pull_status",
    "pull_reason",
    "case_size",
    "unit_of_measurement",
    "case_type",
    "pack_size",
    "case_width_in",
    "case_height_in",
    "case_length_in",
    "case_weight_kg",
    "price_total",
    "price_per_unit",
    "raw_listed_pricing",
    "moq",
    "tiers_updated_at",
    "lead_id",
  ];

  const dimsByPack = await loadMarketplaceCaseDims(admin);

  // Expand each lead into one row per price tier. If no tiers exist, emit one
  // row with empty tier columns so every lead is still visible in the export.
  const csvRows: CsvCell[][] = [];
  for (const r of rows) {
    const p = r.payload ?? {};
    const sourceUrl: string | null = p.source_url ?? p.supplier_website ?? null;
    const siteType: string | null = SITE_TYPE_LABEL[p.site_type] ?? p.site_type ?? null;
    const pull = p.marketplace_pull as { status?: string; reason?: string } | undefined;
    const pullStatus = PULL_STATUS_LABEL[pull?.status ?? ""] ?? (pull?.status ?? "Pending");
    const pullReason: string | null = pull?.reason ?? null;
    const rawPricing: string | null = p.pack_sizes_pricing ?? null;
    const moq: string | null = p.moq ?? null;
    const updatedAt: string | null = p.price_tiers_updated_at ?? null;
    const materialName = correctMaterialSpelling(r.material_name);

    const tiers: {
      pack_size?: string | null;
      price?: number | null;
      unit_price?: number | null;
      case_size?: number | null;
      unit_of_measurement?: string | null;
      case_type?: string | null;
    }[] = Array.isArray(p.price_tiers) && p.price_tiers.length > 0 ? p.price_tiers : [{}];

    for (const t of tiers) {
      const dims = resolveCaseDims(dimsByPack, t.pack_size ?? null);
      // Structured pack-size split (case_size / unit / case_type) so the export
      // maps straight onto the Tenkara quote columns. Prefer operator-entered
      // values; otherwise derive them from the free-text pack_size. case_type
      // prefers the curated case-dimensions value, falling back to the parse.
      const b = tierBreakdown({
        pack_size: t.pack_size ?? null,
        price: t.price ?? null,
        unit_price: t.unit_price ?? null,
        case_size: t.case_size ?? null,
        unit_of_measurement: t.unit_of_measurement ?? null,
        case_type: t.case_type ?? null,
      });
      csvRows.push([
        r.supplier_name ?? null,
        materialName,
        sourceUrl,
        siteType,
        pullStatus,
        pullReason,
        b.case_size,
        b.unit_of_measurement,
        dims?.case_type ?? b.case_type,
        t.pack_size ?? null,
        dims?.width ?? null,
        dims?.height ?? null,
        dims?.length ?? null,
        dims?.weight_kg ?? null,
        t.price ?? null,
        t.unit_price ?? null,
        rawPricing,
        moq,
        updatedAt,
        r.id,
      ]);
    }
  }

  const body = toCsv(headers, csvRows);
  const iso = new Date().toISOString().slice(0, 10);
  const fileOrg = orgSlug || "all-orgs";
  const filename = `marketplace-pricing-${fileOrg}-${iso}.csv`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
