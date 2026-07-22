// Client classification — mirrors automations/config.yaml from the SuperAgent
// build. Names MUST match `organizations.name` in Tenkara prod exactly.

export type OutreachMode = "active" | "ghost" | "skip";

export const ACTIVE_CLIENTS: string[] = [
  "Bobber Labs",
  "Nutripro",
  "PharmaLab",
  "Vita Organica",
  "California Chemicals",
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
  // Internal Sourcing consolidates under the Sierra Materials Co ghost brand
  // (info@sierramaterialsco.com). Never send as Tenkara or Rove for these.
  "Tenkara": "Sierra Materials Co",
  "Tenkara (Internal Sourcing)": "Sierra Materials Co",
  "Catalyst Chemical Solutions": "Rove Essentials",
  "Nitro Logistics": "Rove Essentials",
};

// Not yet built out on Tenkara — no inbox mapped in TENKARA_EMAIL_ACCOUNT_IDS,
// so a draft would be created without a sender and be invisible in the app.
// Skip until Rod provisions their Tenkara inboxes, then move back to ACTIVE_CLIENTS.
export const SKIP_CLIENTS: string[] = [
  "McGinley",
  "Sphere",
  "Ulo",
];

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

// Inboxes Agent 08 scans for supplier replies. Missive's routing rules file an
// inbound reply into a stage-based teamspace (1 Inquiries, 2 Quotes, …) on the
// Bobber Labs account, NOT the agent sandbox where the draft was staged. So we
// scan all of them and match by sender email — a reply is caught wherever the
// rules drop it. (We can't read Missive's rules via API, so we cover the
// landing zones instead.) Override with MISSIVE_REPLY_SCAN_TEAM_IDS (csv).
export const MISSIVE_REPLY_SCAN_TEAM_IDS: string[] = (
  process.env.MISSIVE_REPLY_SCAN_TEAM_IDS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []
).length
  ? process.env.MISSIVE_REPLY_SCAN_TEAM_IDS!.split(",").map((s) => s.trim()).filter(Boolean)
  : [
      MISSIVE_TEAM_ID,                                  // Operators Assistant Agent (sandbox)
      "759f7f45-cc19-428a-8a79-e73e24400f17",           // 0 General Inbox
      "98d37785-ed41-4c3b-a279-f00c601763ab",           // 1 Inquiries
      "f993f9dc-3841-416e-8ec0-d6ea172af244",           // 2 Quotes
      "a9c9ef33-6ede-40c8-b035-2bd9e42f0be7",           // 3 Purchase Orders
      "682adaaa-cbb7-434f-a88d-d7377ddf8b42",           // 4 Order Confirmation
      "41e75316-da3b-4d53-822e-dbad8ed42f72",           // 5 Shipment Tracking
      "315dda15-2c1c-485f-a2f6-6fdcece1bc0d",           // 6 Cancellation and Disputes
      "8d7be553-6bf6-4286-b0c2-3a79c1cbde6e",           // 7 Escalations
      "5f596584-0801-4155-aa58-cc3433bbd7d4",           // 8 Miscellaneous
    ];
