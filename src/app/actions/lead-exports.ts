"use server";
import { revalidatePath } from "next/cache";
import { getSession, canSeeAgentTab } from "@/lib/auth";
import { executeAgentRun } from "@/agents-runtime/runtime";

// Re-trigger the Lead Scanner CSV Push agent end-to-end.
// Per-export retry would require Agent 11 to accept a target supplier list;
// for now we just kick the whole sweep — the 7-day supplier dedup keeps it idempotent.
export async function retriggerLeadExport() {
  const session = await getSession();
  if (!session || !canSeeAgentTab(session)) return { ok: false, error: "forbidden" } as const;
  try {
    const r = await executeAgentRun({ agentSlug: "agent-11-lead-scanner-csv-push", triggerSource: "manual" });
    revalidatePath("/agents/health");
    if (!r.ok) return { ok: false, error: r.error } as const;
    return { ok: true, runId: r.runId } as const;
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "run failed" } as const;
  }
}
