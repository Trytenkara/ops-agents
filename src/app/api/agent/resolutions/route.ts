import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, unauthorized } from "@/lib/agent-auth";
import { createAdminClient } from "@/lib/supabase/admin";

// Polling fallback for SuperAgent webhooks (§6.5). Returns human-resolved items
// (drafts marked reviewed, approvals decided, cases resolved) since `since`.

const PAGE_SIZE = 100;

export async function GET(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) return unauthorized();
  const since = request.nextUrl.searchParams.get("since") ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const admin = createAdminClient();

  const [drafts, approvals, cases] = await Promise.all([
    admin
      .from("draft_references")
      .select("id, status, reviewed_at, reviewer, quote_id, supplier_id, material_id, agent_run_id", { count: "exact" })
      .eq("agent_id", agent.id)
      .in("status", ["reviewed", "sent", "discarded"])
      .gte("updated_at", since)
      .order("updated_at", { ascending: true })
      .limit(PAGE_SIZE),
    admin
      .from("pending_approvals")
      .select("id, status, decided_at, decided_by, type, payload", { count: "exact" })
      .eq("requested_by_agent", agent.id)
      .in("status", ["approved", "rejected", "needs_edit", "ready_for_export", "exported"])
      .gte("decided_at", since)
      .order("decided_at", { ascending: true })
      .limit(PAGE_SIZE),
    admin
      .from("cases")
      .select("id, status, resolved_at, resolution_note, type, supplier_id, material_id", { count: "exact" })
      .in("status", ["resolved", "dismissed"])
      .gte("resolved_at", since)
      .order("resolved_at", { ascending: true })
      .limit(PAGE_SIZE),
  ]);

  // PERS-06: this is a since-cursor feed, so a caller that is handed 100 rows
  // with no remainder walks the cursor forward past everything it never saw.
  // Oldest first and a stated remainder, so the next call resumes rather than
  // skips.
  const left = (r: { data: any[] | null; count: number | null }) =>
    Math.max((r.count ?? r.data?.length ?? 0) - (r.data?.length ?? 0), 0);
  const lastSeen = (r: { data: any[] | null; count: number | null }, field: string) =>
    left(r) > 0 ? (r.data?.[r.data.length - 1]?.[field] as string | undefined) ?? null : null;

  // `until` is the caller's next `since`. When a feed was truncated, the cursor
  // stops at the last row actually handed over instead of at now.
  const stops = [
    lastSeen(drafts, "reviewed_at"),
    lastSeen(approvals, "decided_at"),
    lastSeen(cases, "resolved_at"),
  ].filter(Boolean) as string[];

  return NextResponse.json({
    drafts: drafts.data ?? [],
    approvals: approvals.data ?? [],
    cases: cases.data ?? [],
    remainder: { drafts: left(drafts), approvals: left(approvals), cases: left(cases) },
    until: stops.length ? stops.sort()[0] : new Date().toISOString(),
  });
}
