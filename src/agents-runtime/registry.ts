// Registry-only module. Agents register themselves here without importing the
// orchestrator, which prevents a circular import (runtime → agents → runtime).

export interface RuntimeContext {
  runId: string;
  agentId: string;
  agentSlug: string;
  // Optional per-run input from a manual trigger (e.g. { materialId } to scope
  // discovery to one material). Empty for scheduled cron runs.
  input?: Record<string, any>;
  log: (
    message: string,
    opts?: { step?: string; level?: "info" | "warn" | "error" | "debug"; data?: Record<string, any> }
  ) => Promise<void>;
  setSummary: (s: string) => void;
  setItemsProcessed: (n: number) => void;
  setStatus: (s: "success" | "partial" | "failure") => void;
  setMetadata: (patch: Record<string, any>) => void;
}

export interface AgentDefinition {
  slug: string;
  displayName: string;
  description: string;
  // How many copies of this agent may run at once. Only set it above 1 when the
  // agent claims its work atomically (see claim_enrichment_leads); otherwise two
  // lanes pick the same rows and every side effect happens twice. The lane number
  // arrives as ctx.input.lane, and phases that must not repeat per run (seeding,
  // sweeps) belong to lane 1 only.
  lanes?: number;
  run: (ctx: RuntimeContext) => Promise<void>;
}

const REGISTRY: Record<string, AgentDefinition> = {};

export function registerAgent(def: AgentDefinition) {
  if (REGISTRY[def.slug]) {
    // Idempotent: a HMR reload or a double-import shouldn't crash.
    REGISTRY[def.slug] = def;
    return;
  }
  REGISTRY[def.slug] = def;
}

export function getAgentDefinition(slug: string): AgentDefinition | null {
  return REGISTRY[slug] ?? null;
}

export function listAgentDefinitions(): AgentDefinition[] {
  return Object.values(REGISTRY);
}
