import Anthropic from "@anthropic-ai/sdk";
import { postSlackMessage } from "@/lib/slack";
import { correctMaterialSpelling } from "@/lib/material-spelling";

// Material names come from Tenkara (read-only). When a name is clearly typo'd
// (e.g. "Butylene G;ycol"), Agent 03 flags a suggested correction and pings the
// ops channel; an operator applies it, writing an OA-side canonical override.

const MODEL = "claude-sonnet-4-5";
const FEEDBACK_CHANNEL = "C0BATUWBHC7"; // #control-room-feedback

// Characters that shouldn't appear inside a material name — these are the
// reliable, zero-false-positive signal (hyphens, commas, periods, parens, %,
// &, / are all legitimate and NOT flagged). Catches junk like "G;ycol".
const BAD_CHARS = /[;:_~^`|{}\[\]<>*!?\\=@#$"]/;

// A real raw-material name is never this long; past this it's malformed/test data.
const MAX_NAME_LEN = 120;

// Repeated-word spam ("... Extra Extra Extra Extra ...") is malformed/test data,
// not a real material. Flag when any word (2+ chars) appears 3+ times — no
// genuine material name repeats the same word that often, so ~zero false positives.
export function repeatedTokenJunk(name: string): boolean {
  const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (words.length < 3) return false;
  const counts = new Map<string, number>();
  for (const w of words) {
    if (w.length < 2) continue;
    const n = (counts.get(w) ?? 0) + 1;
    if (n >= 3) return true;
    counts.set(w, n);
  }
  return false;
}

// Malformed = junk *content* (over-long or repeated-word spam), as opposed to a
// typo (bad punctuation). These get a deterministic flag + hold, not an LLM fix.
export function isMalformed(name: string): boolean {
  return name.length > MAX_NAME_LEN || repeatedTokenJunk(name);
}

export function looksSuspicious(name: string | null | undefined): boolean {
  if (!name) return false;
  return BAD_CHARS.test(name) || isMalformed(name);
}

// Best-effort cleanup for a malformed name: collapse runs of the same word and
// trim. Only a suggestion — an operator reviews before it's applied.
export function cleanMalformed(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev && prev.toLowerCase() === p.toLowerCase()) continue;
    out.push(p);
  }
  const cleaned = out.join(" ").trim();
  return cleaned.slice(0, MAX_NAME_LEN).trim() || name.slice(0, MAX_NAME_LEN).trim();
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
  const allNames = Array.from(new Set(names.filter(Boolean)));
  const suspicious = allNames.filter(looksSuspicious);

  // Clean dictionary typos that looksSuspicious() misses (no junk chars) — the
  // raw source name matches the curated misspelling list, e.g. "Cayanne Pepper".
  // Deterministic (no LLM). These are typos in the Tenkara source record, so the
  // fix is a rename at the source, not just an OA-side override. We also detect
  // the resulting DUPLICATE: if the corrected spelling already exists as another
  // live material, the client has two records for the same thing.
  const present = new Set(allNames.map((n) => n.toLowerCase()));
  const sourceTypos = new Map<string, { suggested: string; duplicate: boolean }>();
  for (const n of allNames) {
    if (looksSuspicious(n)) continue; // covered by the suspicious path below
    const fix = correctMaterialSpelling(n);
    if (fix && fix.toLowerCase() !== n.toLowerCase()) {
      sourceTypos.set(n, { suggested: fix, duplicate: present.has(fix.toLowerCase()) });
    }
  }

  if (!suspicious.length && !sourceTypos.size) return 0;

  // Skip names already flagged (any status) so we don't re-ping.
  const { data: existing } = await admin
    .from("material_name_flags")
    .select("wrong_name")
    .eq("org_id", orgId);
  const seen = new Set((existing ?? []).map((r: any) => (r.wrong_name as string).toLowerCase()));
  const fresh = suspicious.filter((n) => !seen.has(n.toLowerCase()));

  // Two problem classes on the suspicious path: typos (LLM suggests a spelling
  // fix) and malformed junk (repeated-word spam / absurd length — likely test
  // data) that must never be drafted. Malformed names get a deterministic flag.
  const malformed = fresh.filter(isMalformed);
  const typoCandidates = fresh.filter((n) => !isMalformed(n));
  const typoFixes = await suggestCorrections(typoCandidates);

  type Flag = { wrong: string; suggested: string; kind: "malformed" | "typo" | "source"; duplicate: boolean };
  const flags: Flag[] = [
    ...malformed.map((wrong) => ({ wrong, suggested: cleanMalformed(wrong), kind: "malformed" as const, duplicate: false })),
    ...Object.entries(typoFixes).map(([wrong, suggested]) => ({ wrong, suggested, kind: "typo" as const, duplicate: false })),
    ...Array.from(sourceTypos.entries())
      .filter(([wrong]) => !seen.has(wrong.toLowerCase()))
      .map(([wrong, { suggested, duplicate }]) => ({ wrong, suggested, kind: "source" as const, duplicate })),
  ];
  if (!flags.length) return 0;

  let flagged = 0;
  for (const f of flags) {
    const { data: ins } = await admin
      .from("material_name_flags")
      .upsert({ org_id: orgId, wrong_name: f.wrong, suggested_name: f.suggested, status: "pending" }, { onConflict: "org_id,wrong_name", ignoreDuplicates: true })
      .select("id")
      .maybeSingle();
    if (!ins) continue; // already existed
    flagged++;
    const preview = f.wrong.length > 80 ? `${f.wrong.slice(0, 80)}…` : f.wrong;
    let text: string;
    if (f.kind === "malformed") {
      text = `:rotating_light: *Malformed material name* — *${orgLabel}*: "${preview}" looks like junk/test data (repeated or over-long text). Outreach is held; fix the name on the client's Materials/Leads page. Suggested cleanup: *"${f.suggested}"*.`;
    } else if (f.kind === "typo") {
      text = `:pencil2: *Material spelling flag* — *${orgLabel}*: "${f.wrong}" looks misspelled → suggest *"${f.suggested}"*. Review on the client's Materials/Leads page to correct all instances.`;
    } else {
      text = `:pencil2: *Material name misspelled at source* — *${orgLabel}*: "${f.wrong}" should be *"${f.suggested}"*.` +
        (f.duplicate ? ` :warning: A separate *"${f.suggested}"* material also exists — these are duplicates; consolidate them.` : "") +
        ` The name comes from Tenkara (read-only here) — rename it in the Tenkara app. The Control Room shows it corrected meanwhile.`;
    }
    await postSlackMessage({ channel: FEEDBACK_CHANNEL, text }).catch(() => {});
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
