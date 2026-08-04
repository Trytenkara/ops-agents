// Client classification — mirrors automations/config.yaml from the SuperAgent
// build. Names MUST match `organizations.name` in Tenkara prod exactly.

export type OutreachMode = "active" | "ghost" | "skip";

export const ACTIVE_CLIENTS: string[] = [
  "Bobber Labs",
  "Nutripro",
  "PharmaLab",
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
  // California Chemicals: discovery + enrichment run (in ONLY_ORG scope) to build
  // the supplier pool, but outreach is held here until Ben provides an email and
  // Rod provisions its Tenkara inbox in TENKARA_EMAIL_ACCOUNT_IDS. Move to
  // ACTIVE_CLIENTS once the inbox exists, or drafts would be sender-less/invisible.
  "California Chemicals",
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

