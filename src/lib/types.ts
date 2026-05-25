// Hand-written DB row types for Phase 1. Swap for supabase gen types in Phase 2.

export type DraftStatus = "staged" | "reviewed" | "sent" | "discarded";

export interface DraftReferenceRow {
  id: string;
  email_client: "missive" | "rod_app";
  thread_id: string;
  draft_id: string;
  agent_run_id: string | null;
  agent_id: string | null;
  org_id: string | null;
  supplier_id: string | null;
  material_id: string | null;
  quote_id: string | null;
  status: DraftStatus;
  assigned_operator: string | null;
  reviewer: string | null;
  reviewed_at: string | null;
  body_preview: string | null;
  subject: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: "idle" | "running" | "paused" | "disabled";
  training_wheels_mode: boolean;
  stamp_of_approval: boolean;
  prompt_version: number;
  schedule_cron: string | null;
  webhook_url: string | null;
  api_key_prefix: string | null;
  last_run_at: string | null;
}

export interface AgentRunRow {
  id: string;
  agent_id: string;
  org_id: string | null;
  run_started_at: string;
  run_finished_at: string | null;
  status: "running" | "success" | "partial" | "failure";
  summary: string | null;
  errors: any;
  items_processed: number;
  token_cost: number | null;
  trigger_source: string | null;
}

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
  tenkara_org_id: string | null;
}
