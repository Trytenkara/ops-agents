import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getAssignedOrgIds } from "@/lib/org-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { signedUrlForPath } from "@/lib/storage";

// GET /api/cases/[id]/form — download the supplier form attached to a case.
// Auth-gated: the user must be signed in and able to see the case's org. We mint
// a short-lived signed URL on demand (the file lives in a private bucket) and
// redirect to it, so links can't be shared and never go stale.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const admin = createAdminClient();
  const { data: c } = await admin
    .from("cases")
    .select("id, org_id, type, metadata")
    .eq("id", params.id)
    .maybeSingle();
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Org access: global roles see all; others must be assigned to the case's org.
  const allowedOrgIds = await getAssignedOrgIds(session);
  if (allowedOrgIds !== null && !allowedOrgIds.includes(c.org_id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const meta = (c.metadata ?? {}) as any;
  const bucket = meta.form_bucket as string | undefined;
  const path = meta.form_storage_path as string | undefined;
  if (!bucket || !path) {
    return NextResponse.json({ error: "no form file on this case" }, { status: 404 });
  }

  const url = await signedUrlForPath(bucket, path, 60);
  if (!url) return NextResponse.json({ error: "could not sign download" }, { status: 500 });

  return NextResponse.redirect(url);
}
