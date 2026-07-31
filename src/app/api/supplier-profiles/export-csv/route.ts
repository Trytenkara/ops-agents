import { NextRequest, NextResponse } from "next/server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds, seesAllOrgs } from "@/lib/org-access";
import { toCsv, type CsvCell } from "@/lib/csv";
import { SUPPLIER_TEMPLATE_HEADERS } from "@/lib/tenkara-templates";
import type { SupplierProfile } from "@/lib/supplier-profiles";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return new NextResponse("unauthorized", { status: 401 });
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const orgId = req.nextUrl.searchParams.get("org_id");
  if (!orgId) return new NextResponse("org_id required", { status: 400 });

  if (!seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && !assigned.includes(orgId)) {
      return new NextResponse("forbidden", { status: 403 });
    }
  }

  const admin = createAdminClient();

  const { data: org } = await admin
    .from("orgs")
    .select("slug")
    .eq("id", orgId)
    .maybeSingle();

  const { data: rows, error } = await admin
    .from("supplier_profiles")
    .select("*")
    .eq("org_id", orgId)
    .order("supplier_name");
  if (error) return new NextResponse(error.message, { status: 500 });

  const profiles = (rows ?? []) as SupplierProfile[];

  const csvRows: CsvCell[][] = profiles.map((p) => {
    const addr = parseAddress(p.shipping_address);
    return [
      p.supplier_id ?? "",                     // id
      p.supplier_name,                         // name
      "",                                      // website
      p.poc_name ?? "",                        // poc_name
      p.poc_email ?? "",                       // poc_email
      p.poc_phone ?? "",                       // poc_phone
      "",                                      // poc_phone_extension
      addr.street,                             // address
      addr.city,                               // city
      addr.state,                              // state
      addr.zip,                                // zip
      addr.country,                            // country
      p.supplier_type === "marketplace",       // is_marketplace
      p.shipping_terms ?? "",                  // shipping_terms
      p.shipping_email ?? "",                  // shipping_email
      p.billing_email ?? "",                   // billing_email
      "",                                      // minimum_order
      "",                                      // minimum_order_unit
      p.supplier_type ?? "",                   // supplier_type
      [p.notes ? `Operator: ${p.notes}` : null, p.generated_notes ? `Generated: ${p.generated_notes}` : null].filter(Boolean).join(" | "), // purchasing_notes
      "",                                      // purchasing_thresholds
      p.ddp_min_limit ?? "",                   // ddp_minimum_limit
      p.ddp_max_limit ?? "",                   // ddp_maximum_limit
    ];
  });

  const csv = toCsv([...SUPPLIER_TEMPLATE_HEADERS], csvRows);
  const slug = org?.slug ?? "suppliers";
  const date = new Date().toISOString().slice(0, 10);
  const filename = `tenkara-suppliers-${slug}-${date}.csv`;

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

function parseAddress(addr: string | null): {
  street: string; city: string; state: string; zip: string; country: string;
} {
  const empty = { street: "", city: "", state: "", zip: "", country: "" };
  if (!addr) return empty;
  const parts = addr.split(",").map((s) => s.trim());
  if (parts.length >= 4) {
    const stateZip = parts[parts.length - 2].split(/\s+/);
    return {
      street: parts.slice(0, parts.length - 3).join(", "),
      city: parts[parts.length - 3],
      state: stateZip[0] ?? "",
      zip: stateZip.slice(1).join(" "),
      country: parts[parts.length - 1],
    };
  }
  return { ...empty, street: addr };
}
