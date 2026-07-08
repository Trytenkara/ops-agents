import Anthropic from "@anthropic-ai/sdk";
import { postSlackMessage } from "@/lib/slack";

// Material names come from Tenkara (read-only). When a name is clearly typo'd
// (e.g. "Butylene G;ycol"), Agent 03 flags a suggested correction and pings the
// ops channel; an operator applies it, writing an OA-side canonical override.

const MODEL = "claude-sonnet-4-5";
const FEEDBACK_CHANNEL = "C0BATUWBHC7"; // #control-room-feedback

// Characters that shouldn't appear inside a material name — these are the
// reliable, zero-false-positive signal (hyphens, commas, periods, parens, %,
// &, / are all legitimate and NOT flagged). Catches junk like "G;ycol".
const BAD_CHARS = /[;:_~^`|{}\[\]<>*!?\\=@#$"]/;

export function looksSuspicious(name: string | null | undefined): boolean {
  if (!name) return false;
  return BAD_CHARS.test(name);
}

let _client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// For each suspicious name, ask for the corrected spelling. Returns only names
// that genuinely need a fix, mapped to the recommendation.
export async function suggestCorrections(names: string[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(names.filter(Boolean)));
  if (!unique.length || !process.env.ANTHROPIC_API_KEY) return {};
  const res = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 1000,
    system:
      "You fix typos in chemical/cosmetic raw-material names. For each input name, if it is misspelled or has stray characters, return the corrected name; if it is already correct, omit it. Never change the actual substance — only fix spelling/punctuation. Return ONLY JSON: {\"corrections\":[{\"wrong\":\"...\",\"correct\":\"...\"}]}.",
    messages: [{ role: "user", content: `Names:\n${unique.map((n) => `- ${n}`).join("\n")}` }],
  });
  const txt = res.content.find((b) => b.type === "text");
  const raw = txt && txt.type === "text" ? txt.text : "";
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s < 0 || e <= s) return {};
  let out: Record<string, string> = {};
  try {
    const parsed = JSON.parse(raw.slice(s, e + 1));
    for (const c of parsed?.corrections ?? []) {
      if (c?.wrong && c?.correct && String(c.wrong).trim() !== String(c.correct).trim()) {
        out[String(c.wrong)] = String(c.correct).trim();
      }
    }
  } catch { /* ignore */ }
  return out;
}

type Admin = { from: (t: string) => any };

// Detect + persist flags for an org's material names, Slack-pinging once per new
// misspelling. Cheap: only suspicious names hit the LLM. Dedup via the unique
// (org, lower(wrong)) index — a re-scan won't re-flag or re-ping.
export async function flagMaterialNames(admin: Admin, orgId: string, names: string[], orgLabel: string): Promise<number> {
  const suspicious = Array.from(new Set(names.filter(looksSuspicious)));
  if (!suspicious.length) return 0;

  // Skip names already flagged (any status) so we don't re-ping.
  const { data: existing } = await admin
    .from("material_name_flags")
    .select("wrong_name")
    .eq("org_id", orgId);
  const seen = new Set((existing ?? []).map((r: any) => (r.wrong_name as string).toLowerCase()));
  const fresh = suspicious.filter((n) => !seen.has(n.toLowerCase()));
  if (!fresh.length) return 0;

  const corrections = await suggestCorrections(fresh);
  let flagged = 0;
  for (const [wrong, correct] of Object.entries(corrections)) {
    const { data: ins } = await admin
      .from("material_name_flags")
      .upsert({ org_id: orgId, wrong_name: wrong, suggested_name: correct, status: "pending" }, { onConflict: "org_id,wrong_name", ignoreDuplicates: true })
      .select("id")
      .maybeSingle();
    if (!ins) continue; // already existed
    flagged++;
    await postSlackMessage({
      channel: FEEDBACK_CHANNEL,
      text: `:pencil2: *Material spelling flag* — *${orgLabel}*: "${wrong}" looks misspelled → suggest *"${correct}"*. Review on the client's Materials/Leads page to correct all instances.`,
    }).catch(() => {});
  }
  return flagged;
}

// Applied overrides for an org: lower(wrong_name) → suggested_name.
export async function appliedCorrections(admin: Admin, orgId: string): Promise<Map<string, string>> {
  const { data } = await admin
    .from("material_name_flags")
    .select("wrong_name, suggested_name")
    .eq("org_id", orgId)
    .eq("status", "applied");
  const m = new Map<string, string>();
  for (const r of (data ?? []) as any[]) m.set((r.wrong_name as string).toLowerCase(), r.suggested_name);
  return m;
}

export function correctName(overrides: Map<string, string>, name: string | null | undefined): string | null {
  if (!name) return name ?? null;
  return overrides.get(name.toLowerCase()) ?? name;
}
