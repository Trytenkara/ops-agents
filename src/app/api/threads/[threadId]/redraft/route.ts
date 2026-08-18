import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getSession, hasAnyRole } from "@/lib/auth";
import { seesAllOrgs, getAssignedOrgIds } from "@/lib/org-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileThread } from "@/agents-runtime/agents/reply-manager/thread-reconcile";

export const dynamic = "force-dynamic";
// Reads the thread from Tenkara and runs the reply drafter, which is a model call
// plus attachment parsing. Past the server-action budget, hence a route.
export const maxDuration = 300;

// "Draft a reply now": the operator's manual trigger for a supplier reply the
// agent left without a draft. It runs the SAME code the scheduled sweep runs
// (reconcileThread), forced past the already-processed ledger, so a hand-triggered
// draft can never diverge from an automatic one.
export async function POST(_request: NextRequest, { params }: { params: { threadId: string } }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!hasAnyRole(session, ["admin", "ops_lead", "ops_operator"])) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { threadId } = params;
  const admin = createAdminClient();
  const { data: refs } = await admin
    .from("draft_references")
    .select("id, org_id, orgs(slug)")
    .eq("thread_id", threadId)
    .limit(1);
  const ref = refs?.[0] as any;
  if (!ref) return NextResponse.json({ error: "unknown_thread" }, { status: 404 });
  if (!seesAllOrgs(session)) {
    const assigned = await getAssignedOrgIds(session);
    if (assigned !== null && ref.org_id && !assigned.includes(ref.org_id)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  try {
    const pass = await reconcileThread(
      admin,
      { agentId: "", runId: "", log: async () => {} },
      threadId,
      { force: true, deadline: Date.now() + 240_000 }
    );
    await admin.from("audit_log").insert({
      actor_user_id: session.userId,
      action: "thread.redraft_requested",
      target_table: "draft_references",
      target_id: ref.id ?? null,
      diff: { thread_id: threadId, drafted: pass.drafted, outcomes: pass.outcomes },
    });
    if (ref.orgs?.slug) revalidatePath(`/work/orgs/${ref.orgs.slug}/threads`);
    return NextResponse.json({
      ok: true,
      drafted: pass.drafted,
      // Why nothing came out, in the drafter's own words, so the operator isn't
      // left guessing at a silent no-op.
      reason: pass.drafted ? null : (pass.outcomes[pass.outcomes.length - 1] ?? "no_supplier_message"),
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 400 });
  }
}
