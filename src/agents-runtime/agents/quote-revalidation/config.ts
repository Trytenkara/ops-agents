// Client classification — mirrors automations/config.yaml from the SuperAgent
// build. Names MUST match `organizations.name` in Tenkara prod exactly.

export type OutreachMode = "active" | "ghost" | "skip";

export const ACTIVE_CLIENTS: string[] = [
  "Bobber Labs",
  "McGinley",
  "Nutripro",
  "PharmaLab",
  "Sphere",
  "Ulo",
  "Vita Organica",
];

export const GHOST_CLIENTS: Record<string, string> = {
  // Arlon's quotes are on-platform but outreach goes out under the Bobber Labs
  // brand (ghost): sign as Bobber Labs, never name Arlon.
  "Arlon Preview": "Bobber Labs",
  "Aurora Innovations": "Bobber Labs",
  "Evan's Organization": "Bobber Labs",
  "Fuel Kitchens": "Bobber Labs",
  "Lakeside Formulations": "Bobber Labs",
  "Meridian Foods Co.": "Bobber Labs",
  "Vitality Labs Inc.": "Bobber Labs",
  "Tenkara": "Rove Essentials",
  "Catalyst Chemical Solutions": "Rove Essentials",
  "Nitro Logistics": "Rove Essentials",
};

export const SKIP_CLIENTS: string[] = [];

export interface Classification {
  mode: OutreachMode;
  ghostBrand?: string;
}

export function classifyClient(name: string): Classification {
  if (SKIP_CLIENTS.includes(name)) return { mode: "skip" };
  if (ACTIVE_CLIENTS.includes(name)) return { mode: "active" };
  if (name in GHOST_CLIENTS) return { mode: "ghost", ghostBrand: GHOST_CLIENTS[name] };
  return { mode: "skip" };  // unknown clients are dropped (same as skip)
}

// Slack operator user IDs (resolved earlier in the SuperAgent run).
export const OPERATOR_SLACK_IDS = {
  rosie: "U081JBXPJP8",
  mildred: "U081R0K8FA6",
  andrea: "U09BRALGRFZ",
};

// Missive teamspace where drafts land — "Auto Outbox Testing" by default.
// Per the original config.yaml; this is the safe sandbox for staged drafts.
export const MISSIVE_ORGANIZATION_ID = "a3f9a8f4-cd9c-4e17-b683-f2ab4cddd996";
// NB: this team is "Operators Assistant Agent" (the agent sandbox), NOT the
// real Bobber Labs operator inbox. Agent 02 stages drafts here today.
export const MISSIVE_TEAM_ID = "bc15c08a-b298-429f-85c0-fda6833c48f9";

// "Bobber Labs" shared label — the real client correspondence Agent 13 reads
// for inbox context. Override with INBOX_CONTEXT_LABEL_ID if it changes.
export const MISSIVE_BOBBER_LABS_LABEL_ID = "d49e9d4a-b2cd-4e16-bf2b-c00dc9b82db9";
