import { NextResponse, type NextRequest } from "next/server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { getAssignedOrgIds } from "@/lib/org-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOC_EDITABLE_FIELDS, type DocType } from "@/lib/supplier-documents";

// PATCH /api/supplier-documents/[id]/fields — correct the fields parsed out of a
// document, plus its expiry date.
//
// Corrections are stored in extracted_overrides, never written back over
// `extracted`, so a later re-parse cannot destroy them. An override equal to what
// the parser already said is dropped rather than stored, which keeps "edited"
// meaning a human actually disagreed.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasAnyRole(session, ["ops_lead", "ops_operator"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: doc } = await admin
    .from("supplier_documents")
    .select("id, org_id, doc_type, extracted, extracted_overrides")
    .eq("id", params.id)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });

  const allowedOrgIds = await getAssignedOrgIds(session);
  if (allowedOrgIds !== null && doc.org_id && !allowedOrgIds.includes(doc.org_id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const incoming = body?.fields;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return NextResponse.json({ error: "expected { fields: { ... } }" }, { status: 400 });
  }

  const spec = DOC_EDITABLE_FIELDS[doc.doc_type as DocType] ?? [];
  const byKey = new Map(spec.map((f) => [f.key, f]));
  const parsed = (doc.extracted ?? {}) as Record<string, any>;
  const overrides = { ...((doc.extracted_overrides ?? {}) as Record<string, any>) };

  let expiresOn: string | null | undefined;

  for (const [key, raw] of Object.entries(incoming)) {
    // expires_on is a real column (it drives the expiry badge), not a parsed
    // extra, so it is accepted here but applied to the column.
    if (key === "expires_on") {
      const v = typeof raw === "string" ? raw.trim() : raw;
      if (v === "" || v == null) expiresOn = null;
      else if (typeof v === "string" && DATE_RE.test(v)) expiresOn = v;
      else return NextResponse.json({ error: "expires_on must be YYYY-MM-DD or empty" }, { status: 400 });
      continue;
    }

    const field = byKey.get(key);
    if (!field) {
      return NextResponse.json(
        { error: `field "${key}" is not editable on a ${doc.doc_type} document` },
        { status: 400 }
      );
    }

    let value: any = typeof raw === "string" ? raw.trim() : raw;
    if (value === "" || value == null) {
      value = null;
    } else if (field.kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) return NextResponse.json({ error: `${field.label} must be a number` }, { status: 400 });
      value = n;
    } else if (field.kind === "date") {
      if (typeof value !== "string" || !DATE_RE.test(value)) {
        return NextResponse.json({ error: `${field.label} must be YYYY-MM-DD or empty` }, { status: 400 });
      }
    } else {
      value = String(value).slice(0, 2000);
    }

    // Agreeing with the parser is not an edit.
    if (value === (parsed[key] ?? null)) delete overrides[key];
    else overrides[key] = value;
  }

  const patch: Record<string, any> = {
    extracted_overrides: overrides,
    extracted_edited_by: session.email,
    extracted_edited_at: new Date().toISOString(),
  };
  if (expiresOn !== undefined) patch.expires_on = expiresOn;

  const { error } = await admin.from("supplier_documents").update(patch).eq("id", doc.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, extracted_overrides: overrides });
}
