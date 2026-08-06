import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { rebalanceOrgAssignments } from "@/lib/rebalance-assignments";

export const dynamic = "force-dynamic";
// A reset on a large client re-points hundreds of threads and mirrors each one
// onto Tenkara, which is well past the default server-action budget. This is why
// the button posts to a route instead of calling a server action.
export const maxDuration = 300;

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  // Deliberately narrower than the rest of the Operator assignment card, which
  // ops_operator may edit: this moves everyone's book at once.
  if (!hasAnyRole(session, ["admin", "ops_lead"])) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;

  try {
    const admin = createAdminClient();
    const result = await rebalanceOrgAssignments(admin, params.id, session.userId, { dryRun });
    if (!dryRun && typeof body?.orgSlug === "string" && body.orgSlug) {
      for (const path of ["", "/leads", "/suppliers", "/threads"]) {
        revalidatePath(`/work/orgs/${body.orgSlug}${path}`);
      }
    }
    return NextResponse.json({ ok: true, dryRun, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
}
