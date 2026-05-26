// Registry-only module. Agents register themselves here without importing the
// orchestrator, which prevents a circular import (runtime → agents → runtime).

export interface RuntimeContext {
  runId: string;
  agentId: string;
  agentSlug: string;
  log: (
    message: string,
    opts?: { step?: string; level?: "info" | "warn" | "error" | "debug"; data?: Record<string, any> }
  ) => Promise<void>;
  setSummary: (s: string) => void;
  setItemsProcessed: (n: number) => void;
  setStatus: (s: "success" | "partial" | "failure") => void;
}

export interface AgentDefinition {
  slug: string;
  displayName: string;
  description: string;
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
