import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

// Polling fallback for SuperAgent webhooks (§6.5). Returns human-resolved items
// (drafts marked reviewed, approvals decided, cases resolved) since `since`.

export async function GET(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const since = request.nextUrl.searchParams.get("since") ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const admin = createAdminClient();

  const [drafts, approvals, cases] = await Promise.all([
    admin
      .from("draft_references")
      .select("id, status, reviewed_at, reviewer, quote_id, supplier_id, material_id, agent_run_id")
      .eq("agent_id", agent.id)
      .in("status", ["reviewed", "sent", "discarded"])
      .gte("updated_at", since)
      .limit(100),
    admin
      .from("pending_approvals")
      .select("id, status, decided_at, decided_by, type, payload")
      .eq("requested_by_agent", agent.id)
      .in("status", ["approved", "rejected", "needs_edit", "ready_for_export", "exported"])
      .gte("decided_at", since)
      .limit(100),
    admin
      .from("cases")
      .select("id, status, resolved_at, resolution_note, type, supplier_id, material_id")
      .in("status", ["resolved", "dismissed"])
      .gte("resolved_at", since)
      .limit(100),
  ]);

  return NextResponse.json({
    drafts: drafts.data ?? [],
    approvals: approvals.data ?? [],
    cases: cases.data ?? [],
    until: new Date().toISOString(),
  });
}
