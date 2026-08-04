import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getAssignedOrgIds } from "@/lib/org-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedUrlForPath } from "@/lib/storage";
import { DOC_BUCKET } from "@/lib/supplier-documents";

// GET /api/supplier-documents/[id] — open a captured qualification document.
// Same shape as the case-form download (0034): auth-gated, short-lived signed
// URL minted on demand from a private bucket.
//
// Rows written before byte storage existed have no storage_path. For those we
// fall back to source_url, but only when it is absolute: email-sourced rows hold
// a relative Tenkara path that needs a bearer token, so there is nothing useful
// to redirect to and saying so beats a 404 the operator has to interpret.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const admin = createAdminClient();
  const { data: doc } = await admin
    .from("supplier_documents")
    .select("id, org_id, storage_path, source_url, source_kind")
    .eq("id", params.id)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 });

  const allowedOrgIds = await getAssignedOrgIds(session);
  if (allowedOrgIds !== null && doc.org_id && !allowedOrgIds.includes(doc.org_id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (doc.storage_path) {
    const url = await signedUrlForPath(DOC_BUCKET, doc.storage_path, 60);
    if (url) return NextResponse.redirect(url);
    return NextResponse.json({ error: "could not sign download" }, { status: 500 });
  }

  if (doc.source_url && /^https?:\/\//i.test(doc.source_url)) {
    return NextResponse.redirect(doc.source_url);
  }

  return NextResponse.json(
    { error: "no stored copy: this document was recorded before file capture, and its only link needs Tenkara credentials" },
    { status: 409 }
  );
}
