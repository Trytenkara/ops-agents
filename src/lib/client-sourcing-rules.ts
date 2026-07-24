import { createAdminClient } from "@/lib/supabase/admin";

// Ops write free-text sourcing rules in two places that, until now, only fed the
// client-profile prose and were otherwise ignored by discovery/outreach:
//   - client_settings.sourcing_notes (the Materials-tab "Sourcing notes" box)
//   - client_uploads rows with kind='note' (the client-profile Documents & Notes)
// The most common one is a country ban ("No China please"). This module parses
// those notes into the same excluded-country signal the structured Tenkara
// settings already produce, so a typed rule and a written rule behave the same.

type Admin = ReturnType<typeof createAdminClient>;

// Canonical country -> the surface forms a supplier.country value might use. We
// add EVERY alias to the excluded set because we don't control how Tenkara
// stores a supplier's country (full name vs ISO code), and exclusionReason
// matches by exact normalized string.
const COUNTRY_ALIASES: Record<string, string[]> = {
  china: ["china", "cn", "chn", "prc", "mainland china", "people's republic of china", "peoples republic of china"],
  india: ["india", "in", "ind"],
  pakistan: ["pakistan", "pk", "pak"],
  bangladesh: ["bangladesh", "bd"],
  vietnam: ["vietnam", "viet nam", "vn"],
  indonesia: ["indonesia", "id", "idn"],
  russia: ["russia", "russian federation", "ru", "rus"],
  iran: ["iran", "ir"],
  "north korea": ["north korea", "dprk", "kp"],
  turkey: ["turkey", "turkiye", "türkiye", "tr"],
  mexico: ["mexico", "méxico", "mx"],
  brazil: ["brazil", "brasil", "br"],
  taiwan: ["taiwan", "tw"],
  thailand: ["thailand", "th"],
  ukraine: ["ukraine", "ua"],
};

// Negation cues that turn a country mention into an exclusion. Deliberately
// broad on cues, narrow on scope (one note line at a time) to keep false
// positives near zero — "we love China's quality" has no cue, so it's ignored.
const NEGATION = /\b(no|not|non|never|avoid|avoiding|exclude|excluding|excl|without|except|ban|banned|prohibit|prohibited|dont|don'?t|do not|no more|steer clear|stay away)\b/;

export interface NoteExclusionHit {
  country: string; // canonical name
  source: string;  // the note text that triggered it (trimmed/truncated)
}

// Parse excluded countries out of free-text notes. Scans line by line; a line
// that carries a negation cue AND names a country excludes that country. Returns
// the alias set to add to excludedCountries plus the hits (for logging).
export function parseExcludedCountriesFromNotes(texts: (string | null | undefined)[]): {
  aliases: Set<string>;
  hits: NoteExclusionHit[];
} {
  const aliases = new Set<string>();
  const hits: NoteExclusionHit[] = [];
  for (const raw of texts) {
    if (!raw) continue;
    for (const line of raw.split(/[\n\r;]+/)) {
      const l = line.toLowerCase();
      if (!NEGATION.test(l)) continue;
      for (const [canon, forms] of Object.entries(COUNTRY_ALIASES)) {
        // Word-boundary match on the canonical name (and multiword aliases).
        const named = forms.some((f) => (f.length <= 3 ? false : new RegExp(`\\b${escapeRe(f)}\\b`).test(l)));
        if (!named) continue;
        forms.forEach((f) => aliases.add(f));
        hits.push({ country: canon, source: line.trim().slice(0, 120) });
      }
    }
  }
  return { aliases, hits };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Load an OA org's free-text sourcing notes (settings box + note uploads) and
// parse them into excluded-country aliases. Best-effort: returns empty on any
// read error so it can never block discovery.
export async function getNoteDerivedCountryExclusions(
  admin: Admin,
  oaOrgId: string
): Promise<{ aliases: Set<string>; hits: NoteExclusionHit[] }> {
  const texts: (string | null)[] = [];
  try {
    const { data: settings } = await admin
      .from("client_settings")
      .select("sourcing_notes")
      .eq("org_id", oaOrgId)
      .maybeSingle();
    if (settings?.sourcing_notes) texts.push(settings.sourcing_notes);

    const { data: notes } = await admin
      .from("client_uploads")
      .select("content_text")
      .eq("org_id", oaOrgId)
      .eq("kind", "note");
    for (const n of notes ?? []) if (n.content_text) texts.push(n.content_text);
  } catch {
    return { aliases: new Set(), hits: [] };
  }
  return parseExcludedCountriesFromNotes(texts);
}
