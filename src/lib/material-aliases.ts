// What the trade calls a material, as opposed to what our client calls it.
//
// Catalogues rarely use the name on the intake form. "Rapeseed Fatty Acid" is
// listed as "Rapeseed Oil Fatty Acid" and "Rapeseed Acid Oil"; searching only
// the literal string returned a clean zero from every source for four days
// while IndiaMART, TradeIndia and ExportersIndia all carried it. Each discovery
// source resolved this independently or not at all, so the fix lives here and
// all three share it.
//
// Model-generated rather than a synonym table: the variants are per-material
// domain knowledge (word order, distillate/by-product names, INCI vs botanical
// vs CAS, industry abbreviations), and a table would only ever cover the
// materials we already knew were broken.

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { advanceDryPass, passOutcome, DRY_PASS_LIMITS, type DryPassState } from "@/lib/dry-pass";

const MODEL = "claude-sonnet-5";
const MAX_ALIASES = 4;
const CALL_TIMEOUT_MS = 60_000;
const ALIAS_KEY = (materialId: string) => `material_aliases:${materialId}`;

const SYSTEM = `You name chemical and ingredient materials the way B2B sellers list them.

Given a material, return the alternative names a supplier catalogue, marketplace listing or customs manifest would actually use for the SAME substance. Consider:
- word-order variants ("Rapeseed Fatty Acid" is listed as "Rapeseed Oil Fatty Acid")
- the distillate / by-product / acid-oil name where the trade treats it as the same item
- INCI vs common vs botanical vs CAS naming
- industry abbreviations and grade shorthands
- the regional spelling used by the main producing region (e.g. rapeseed vs canola, colza)

Rules:
- Same substance only. An alias is a DIFFERENT NAME FOR THE SAME THING, never a narrower or broader version of it. Returning nothing is better than returning a near miss.
- NEVER add or change a grade, purity, refinement state or quality qualifier. For "Olive Oil", the aliases are "Olea Europaea Fruit Oil" (INCI) and "Sweet Oil"; "Extra Virgin Olive Oil", "Virgin Olive Oil", "Pomace Olive Oil" and "Refined Olive Oil" are all WRONG because each is a specific grade the buyer did not ask for. Likewise "Refined Coconut Oil" is not an alias of "Coconut Oil". If the input names a grade, keep that exact grade in every alias.
- No downstream derivatives, salts, esters or blends unless the trade genuinely sells them under the input name.
- Do not repeat the input name or trivially re-case it.
- Order by how likely a seller is to use it, most likely first.
- Return at most ${MAX_ALIASES}. Fewer is fine. An empty list is fine for a material whose name is already the standard trade name.

Return ONLY a JSON object: {"aliases": ["...", "..."]}`;

export interface AliasMaterial {
  id: string;
  name: string | null;
  inci?: string | null;
  trade_name?: string | null;
}

// Grade is a hard spec: a buyer asking for Palm Oil must not be shown Crude
// Palm Oil suppliers. The prompt says so and the model mostly complies, but
// "mostly" is not good enough for a spec, so an alias may not introduce a
// grade/state qualifier the input did not already carry. This only ever removes
// candidates, so a word missing from the list costs breadth, never correctness.
export const GRADE_WORDS = [
  "crude", "refined", "rbd", "virgin", "extra", "pomace", "unrefined", "bleached",
  "deodorized", "technical", "food", "feed", "pharma", "pharmaceutical", "cosmetic",
  "usp", "ep", "bp", "acs", "reagent", "anhydrous", "hydrous", "pure", "purified",
  "organic", "conventional", "distilled", "fractionated", "hydrogenated", "raw",
];

export function gradeWords(s: string): Set<string> {
  const words = new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/));
  return new Set(GRADE_WORDS.filter((g) => words.has(g)));
}

function parseAliases(text: string, exclude: Set<string>): string[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set(exclude);
  const inputGrades = gradeWords([...exclude].join(" "));
  for (const a of Array.isArray(parsed?.aliases) ? parsed.aliases : []) {
    if (typeof a !== "string") continue;
    const trimmed = a.trim();
    // A 2-char "alias" is noise, and a sentence is the model explaining itself.
    if (trimmed.length < 3 || trimmed.length > 120) continue;
    const norm = trimmed.toLowerCase();
    if (seen.has(norm)) continue;
    const added = [...gradeWords(trimmed)].filter((g) => !inputGrades.has(g));
    if (added.length) continue;
    seen.add(norm);
    out.push(trimmed);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

// Resolved per material and cached in agent_state — every discovery source asks
// for the same material. Fails open to []: a missing alias list costs breadth, a
// thrown error costs the whole discovery pass.
//
// PERS-03: an EMPTY answer is not cached as the answer. A truncated response, a
// JSON-parse miss and a material whose name really is the catalogue name all
// produce the same [], and caching that with no expiry blinds all three sources
// for that material permanently — the exact failure the header describes. An
// empty result banks a dry pass instead and is re-resolved until
// DRY_PASS_LIMITS.material_aliases of them agree. A failure banks nothing.
export async function getMaterialAliases(
  admin: SupabaseClient,
  agentId: string,
  material: AliasMaterial,
  log?: (msg: string, meta?: Record<string, unknown>) => Promise<void> | void
): Promise<string[]> {
  const known = new Set(
    [material.name, material.inci, material.trade_name]
      .filter((v): v is string => !!v)
      .map((v) => v.trim().toLowerCase())
  );
  if (!material.name) return [];

  let prior: DryPassState | null = null;
  try {
    const { data } = await admin
      .from("agent_state")
      .select("value")
      .eq("agent_id", agentId)
      .eq("key", ALIAS_KEY(material.id))
      .maybeSingle();
    const value = data?.value as any;
    const cached = value?.aliases;
    if (Array.isArray(cached)) {
      const names = cached.filter((a: any) => typeof a === "string");
      if (names.length) return names;
      prior = { dry: Number(value?.dry ?? 0), done: !!value?.done };
      if (prior.done) return [];
    }
  } catch {
    // Cache miss and cache failure are the same thing here: resolve it fresh.
  }

  // No key is an infrastructure failure, not an answer. Say so: silently
  // degrading every source to literal-name-only searching is what a rotated
  // key looks like from the outside.
  if (!process.env.ANTHROPIC_API_KEY) {
    await log?.(`Alias resolution unavailable for ${material.name}: ANTHROPIC_API_KEY not set`, {
      level: "warn",
      material_id: material.id,
    });
    return [];
  }
  let aliases: string[] = [];
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const parts = [`name: ${material.name}`];
    if (material.inci) parts.push(`INCI: ${material.inci}`);
    if (material.trade_name) parts.push(`trade name: ${material.trade_name}`);
    const res = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 500,
        system: SYSTEM,
        messages: [{ role: "user", content: parts.join("\n") }],
      },
      { timeout: CALL_TIMEOUT_MS }
    );
    const text = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
    aliases = parseAliases(text, known);
  } catch (e: any) {
    await log?.(`Alias resolution failed for ${material.name} (non-fatal): ${e?.message ?? e}`, {
      level: "warn",
      material_id: material.id,
    });
    return [];
  }

  const pass = advanceDryPass(prior, passOutcome(aliases.length > 0, false), "material_aliases");
  try {
    await admin.from("agent_state").upsert(
      {
        agent_id: agentId,
        key: ALIAS_KEY(material.id),
        value: { aliases, at: new Date().toISOString(), dry: pass.dry, done: pass.done },
      },
      { onConflict: "agent_id,key" }
    );
  } catch {
    // Uncached is fine, it just costs one call next run.
  }
  if (pass.note) await log?.(`Retry bound reached — ${material.name}: ${pass.note}`, { material_id: material.id });
  await log?.(
    aliases.length
      ? `Trade aliases for ${material.name}: ${aliases.join(", ")}`
      : `No trade aliases for ${material.name} on dry pass ${pass.dry} of ${DRY_PASS_LIMITS.material_aliases}` +
          (pass.done ? " — settled: the name is the catalogue name" : ", will re-resolve next run"),
    { material_id: material.id, aliases }
  );
  return aliases;
}
