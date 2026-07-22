import { NextRequest, NextResponse } from "next/server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAssignedOrgIds } from "@/lib/org-access";
import { toCsv, type CsvCell } from "@/lib/csv";
import { correctMaterialSpelling } from "@/lib/material-spelling";

// GET /api/leads-in-flight/export-csv?stage=raw&material=SCI&source=ai_discovery&drift=1
// RLS-scoped to caller's assigned orgs. Mirrors the filters available on
// /work/leads so ops can filter -> export the exact slice they're looking at.

const STAGES = ["raw", "enriched", "ready_for_outreach", "ready_for_approval", "terminal"] as const;
type Stage = (typeof STAGES)[number];

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return new NextResponse("unauthorized", { status: 401 });
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator", "monitor"])) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  const stage: Stage = (STAGES as readonly string[]).includes(sp.get("stage") ?? "")
    ? (sp.get("stage") as Stage)
    : "raw";
  const driftOnly = sp.get("drift") === "1";
  const material = (sp.get("material") ?? "").trim();
  const source = (sp.get("source") ?? "").trim();
  const status = (sp.get("status") ?? "").trim();
  const orgSlug = (sp.get("org") ?? "").trim();
  const channel = (sp.get("channel") ?? "").trim();
  const pricedOnly = sp.get("priced") === "1";

  const admin = createAdminClient();
  const assigned = await getAssignedOrgIds(session);

  // Resolve org slug -> id, validated against the caller's assigned orgs so a
  // scoped user can't escape RLS by passing an arbitrary slug.
  let selectedOrgId: string | null = null;
  if (orgSlug) {
    const { data: orgRow } = await admin.from("orgs").select("id, slug").eq("slug", orgSlug).maybeSingle();
    if (orgRow) {
      if (assigned && !assigned.includes(orgRow.id)) {
        return new NextResponse("forbidden", { status: 403 });
      }
      selectedOrgId = orgRow.id;
    }
  }

  let q = admin
    .from("leads_in_flight")
    .select(
      "id, org_id, supplier_name, supplier_id, material_name, material_id, stage, status, source, payload, drop_reason, confidence_score, agent_run_id, created_at, orgs(slug, name)"
    )
    .eq("stage", stage)
    .order("confidence_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (status) {
    q = q.eq("status", status);
  } else if (stage === "terminal") {
    q = q.in("status", ["active", "dropped", "terminal"]);
  } else {
    q = q.eq("status", "active");
  }
  if (selectedOrgId) q = q.eq("org_id", selectedOrgId);
  else if (assigned) q = q.in("org_id", assigned);
  if (driftOnly) q = q.eq("payload->>catalog_drift", "no_longer_listed");
  if (material) {
    const esc = material.replace(/[,()]/g, " ");
    q = q.or(`material_name.ilike.%${esc}%,payload->>inci_name.ilike.%${esc}%`);
  }
  if (source) q = q.eq("source", source);
  if (channel === "M" || channel === "MS" || channel === "N") q = q.eq("payload->>site_type", channel);
  if (pricedOnly) q = q.not("payload->>pack_sizes_pricing", "is", null);

  const { data: rows, error } = await q;
  if (error) return new NextResponse(error.message, { status: 500 });

  // Column order mirrors Ben's "Vita Organica – Supplier Sourcing" sheet so the
  // export drops into the same workflow: material → supplier identity → the
  // actionable RFQ fields (pricing, contact, MOQ, grades, certs) → provenance.
  const headers = [
    "id",
    "org_slug",
    "org_name",
    "material_name",
    "inci_name",
    "trade_name",
    "supplier_name",
    "role",
    "site_type",
    "country",
    "listing_url",
    "pack_sizes_pricing",
    "sales_email",
    "sales_phone",
    "hq_address",
    "supplier_background",
    "grades_offered",
    "certifications",
    "moq",
    "stage",
    "status",
    "source",
    "signal",
    "signal_count",
    "confidence_score",
    "completeness_score",
    "source_citations",
    "notes",
    "catalog_drift",
    "enrichment_blocked_reason",
    "drop_reason",
    "agent_run_id",
    "created_at",
  ];

  const body = toCsv(
    headers,
    (rows ?? []).map((r: any) => {
      const p = r.payload ?? {};
      const citations: string[] = Array.isArray(p.source_citations) ? p.source_citations : [];
      return [
        r.id,
        r.orgs?.slug ?? null,
        r.orgs?.name ?? null,
        correctMaterialSpelling(r.material_name),
        p.inci_name ?? null,
        p.trade_name ?? null,
        r.supplier_name,
        p.supplier_role ?? null,
        p.site_type ?? null,
        p.supplier_country ?? null,
        p.supplier_website ?? p.source_url ?? null,
        p.pack_sizes_pricing ?? null,
        p.supplier_contact_email ?? null,
        p.supplier_phone ?? null,
        p.hq_address ?? null,
        p.supplier_background ?? null,
        p.grades_offered ?? null,
        p.certifications ?? null,
        p.moq ?? null,
        r.stage,
        r.status,
        r.source,
        p.signal ?? null,
        p.signal_count ?? null,
        r.confidence_score,
        p.completeness_score ?? null,
        citations.join("; ") || null,
        p.scout_notes ?? p.scout_rationale ?? null,
        p.catalog_drift ?? null,
        p.enrichment_blocked_reason ?? null,
        r.drop_reason,
        r.agent_run_id,
        r.created_at,
      ] as CsvCell[];
    })
  );

  const iso = new Date().toISOString().slice(0, 10);
  const slug = buildFilterSlug({ stage, material, source, status, driftOnly, org: orgSlug });
  const filename = `leads-in-flight-${slug}-${iso}.csv`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

function buildFilterSlug({
  stage,
  material,
  source,
  status,
  driftOnly,
  org,
}: {
  stage: string;
  material: string;
  source: string;
  status: string;
  driftOnly: boolean;
  org: string;
}) {
  const parts: string[] = [`stage-${stage}`];
  if (org) parts.push(`org-${slugify(org)}`);
  if (material) parts.push(`material-${slugify(material)}`);
  if (source) parts.push(`source-${slugify(source)}`);
  if (status) parts.push(`status-${slugify(status)}`);
  if (driftOnly) parts.push("drift");
  return parts.join("_");
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "all";
}
