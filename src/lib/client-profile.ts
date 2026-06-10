import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { tenkaraQuery } from "@/lib/tenkara-readonly";

// Client-profile generator. The agent does the work, not ops:
//   1. pull the client's Tenkara data (quotes, suppliers, materials, contacts),
//   2. read any client_settings entries ops typed,
//   3. fold in uploaded info (notes / extracted file text),
//   4. comb the open web (Anthropic web_search),
// then summarize it all into client_profiles. Ops can edit to fix mistakes
// (manual_override); auto-refresh respects that, an explicit regen overrides it.
//
// OA writes only; Tenkara is read-only and best-effort (a Tenkara outage just
// means we generate from the rest).

const MODEL = "claude-sonnet-4-5";
const MAX_OUTPUT_TOKENS = 4000;
const MAX_WEB_USES = 5;
const STALE_DAYS = 7;

export type ClientType = "active" | "ghost" | "skip" | "prospect";

export interface GenerateResult {
  status: "generated" | "skipped_override" | "no_org" | "error";
  clientType?: ClientType;
  error?: string;
}

let _client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

interface TenkaraData {
  name: string | null;
  connectedEmail: string | null;
  marginPercentage: number | null;
  enabledModules: any;
  createdAt: string | null;
  contacts: { name: string; email: string }[];
  materials: { label: string; volume: string | null; needType: string | null }[];
  quoteCount: number;
  supplierCount: number;
  topSuppliers: { name: string; lastQuote: string | null }[];
}

async function gatherTenkaraData(tenkaraOrgId: string): Promise<TenkaraData | null> {
  try {
    const orgRows = await tenkaraQuery<any>(
      `select name, connected_email, margin_percentage, enabled_modules, created_at
         from public.organizations where id = $1::uuid`,
      [tenkaraOrgId]
    );
    if (!orgRows.length) return null;
    const org = orgRows[0];

    const [contacts, materials, quoteAgg, topSuppliers] = await Promise.all([
      tenkaraQuery<any>(
        `select coalesce(nullif(trim(concat_ws(' ', firstname, lastname)), ''), email) as name, email
           from public.users where organization_id = $1::uuid order by created_at limit 25`,
        [tenkaraOrgId]
      ),
      tenkaraQuery<any>(
        `select coalesce(m.trade_name, m.name) as label,
                m.annual_volume_expected, m.volume_unit, m.need_type
           from public.materials m join public.users u on u.id = m.user_id
          where u.organization_id = $1::uuid and coalesce(m.trade_name, m.name) is not null
          order by m.created_at desc limit 30`,
        [tenkaraOrgId]
      ),
      tenkaraQuery<any>(
        `select count(*)::int as quotes, count(distinct q.supplier_id)::int as suppliers
           from public.material_quotes q join public.users u on u.id = q.user_id
          where u.organization_id = $1::uuid`,
        [tenkaraOrgId]
      ),
      tenkaraQuery<any>(
        `select s.name, max(q.quote_date)::text as last_quote
           from public.material_quotes q
           join public.users u on u.id = q.user_id
           join public.suppliers s on s.id = q.supplier_id
          where u.organization_id = $1::uuid
          group by s.name order by max(q.quote_date) desc nulls last limit 10`,
        [tenkaraOrgId]
      ),
    ]);

    return {
      name: org.name ?? null,
      connectedEmail: org.connected_email ?? null,
      marginPercentage: org.margin_percentage ?? null,
      enabledModules: org.enabled_modules ?? null,
      createdAt: org.created_at ? new Date(org.created_at).toISOString() : null,
      contacts: contacts.map((c) => ({ name: c.name, email: c.email })),
      materials: materials.map((m) => ({
        label: m.label,
        volume: m.annual_volume_expected != null ? `${m.annual_volume_expected}${m.volume_unit ? ` ${m.volume_unit}` : ""}/yr` : null,
        needType: m.need_type ?? null,
      })),
      quoteCount: quoteAgg[0]?.quotes ?? 0,
      supplierCount: quoteAgg[0]?.suppliers ?? 0,
      topSuppliers: (topSuppliers ?? []).map((s) => ({ name: s.name, lastQuote: s.last_quote ?? null })),
    };
  } catch {
    return null; // Tenkara best-effort
  }
}

function deriveClientType(
  outreachMode: string | null | undefined,
  activity: { quotes: number; oaLeads: number; oaDrafts: number }
): ClientType {
  if (outreachMode === "ghost") return "ghost";
  if (outreachMode === "skip") return "skip";
  const hasActivity = activity.quotes > 0 || activity.oaLeads > 0 || activity.oaDrafts > 0;
  return hasActivity ? "active" : "prospect";
}

const SYSTEM_PROMPT = `You build client profiles for the operations team at Tenkara, a B2B ingredient-sourcing platform. The "client" is a company that sources raw materials through Tenkara. Operators represent the client to suppliers (over email/call), so the profile must answer the questions suppliers typically ask about the client.

You are given internal data we hold on the client plus any notes ops uploaded. Use the web_search tool to research the company publicly (their website, what they make/sell, how long they've been in business, location, size, brands), then fill out the profile.

Return ONLY a JSON object (no prose):
{
  "summary": "<markdown, 100-180 words: who they are, what they make/buy, how they use Tenkara, anything notable for an operator representing them>",
  "highlights": ["<=6 short factual bullets"],
  "rep_sheet": {
    "years_in_business": "<how long in business / founded year, or null>",
    "products": "<what the company makes/sells, or null>",
    "address": "<business address or city/country, or null>",
    "end_use": "<what the sourced materials are used for, or null>",
    "volume": "<monthly/annual volume of materials needed — use the internal volume figures if present, or null>",
    "order_timing": "<when they plan to place orders, or null>",
    "intended_use": "<'resale/distribution' or 'manufacturing' (or 'unknown')>",
    "can_meet_in_person": "<yes/no/where, or null>"
  },
  "sources": [{"title": "<page title>", "url": "<https url you actually visited>"}]
}

Rules:
- Ground claims in the internal data and pages you actually visited via web_search. Do NOT fabricate URLs, figures, addresses, or dates.
- For any rep_sheet field you can't determine from research or internal data, use null — do NOT guess. Operators will fill those in. order_timing, intended_use and can_meet_in_person often aren't public; leave null/'unknown' unless the data says otherwise.
- Prefer the internal volume/material figures for "volume" and "end_use".
- Keep it operator-useful, not marketing fluff.`;

function buildUserMessage(input: {
  orgName: string;
  tenkara: TenkaraData | null;
  settings: any | null;
  uploads: { kind: string; file_name: string | null; content_text: string | null }[];
  oaActivity: { leads: number; drafts: number };
}): string {
  const p: string[] = [];
  p.push(`Client (organization): ${input.orgName}`);
  const t = input.tenkara;
  if (t) {
    p.push(`\nTenkara data we hold:`);
    if (t.connectedEmail) p.push(`  connected email: ${t.connectedEmail}`);
    if (t.marginPercentage != null) p.push(`  margin %: ${t.marginPercentage}`);
    if (t.enabledModules) p.push(`  enabled modules: ${JSON.stringify(t.enabledModules)}`);
    p.push(`  quotes: ${t.quoteCount} · suppliers used: ${t.supplierCount}`);
    if (t.materials.length) {
      p.push(`  materials sourced (${t.materials.length}) — name [volume] [need type]:`);
      for (const m of t.materials.slice(0, 25)) {
        p.push(`    - ${m.label}${m.volume ? ` [${m.volume}]` : ""}${m.needType ? ` [${m.needType}]` : ""}`);
      }
    }
    if (t.topSuppliers.length) p.push(`  recent suppliers: ${t.topSuppliers.map((s) => `${s.name}${s.lastQuote ? ` (${s.lastQuote})` : ""}`).join(", ")}`);
    if (t.contacts.length) p.push(`  contacts: ${t.contacts.map((c) => `${c.name} <${c.email}>`).join(", ")}`);
  } else {
    p.push(`\n(No Tenkara data available for this client.)`);
  }
  p.push(`\nOA pipeline activity: ${input.oaActivity.leads} leads, ${input.oaActivity.drafts} drafts.`);
  if (input.settings) {
    const s = input.settings;
    const entries = [
      s.outreach_mode && `outreach mode: ${s.outreach_mode}`,
      s.ghost_brand && `ghost brand: ${s.ghost_brand}`,
      s.priority_tier && s.priority_tier !== "standard" && `priority: ${s.priority_tier}`,
      s.primary_contact_name && `primary contact: ${s.primary_contact_name}`,
      s.primary_contact_email && `contact email: ${s.primary_contact_email}`,
      s.sourcing_notes && `notes: ${s.sourcing_notes}`,
    ].filter(Boolean);
    if (entries.length) p.push(`\nOps-entered client settings:\n  ${entries.join("\n  ")}`);
  }
  if (input.uploads.length) {
    p.push(`\nUploaded info from ops:`);
    for (const u of input.uploads) {
      const body = (u.content_text ?? "").slice(0, 4000);
      p.push(`  - ${u.file_name ?? u.kind}: ${body || "(binary file, no extracted text)"}`);
    }
  }
  p.push(`\nResearch this client on the web and return the JSON profile.`);
  return p.join("\n");
}

// The supplier-facing rep sheet: the questions suppliers typically ask about a
// client, which an operator must be able to answer when representing them.
export const REP_FIELDS = [
  { key: "years_in_business", label: "Years in business" },
  { key: "products", label: "Company / products" },
  { key: "address", label: "Address" },
  { key: "end_use", label: "End use of material" },
  { key: "volume", label: "Volume needed (monthly/annual)" },
  { key: "order_timing", label: "Order timing" },
  { key: "intended_use", label: "Intended use (resale/distribution vs manufacturing)" },
  { key: "can_meet_in_person", label: "Can meet in person" },
] as const;
export type RepSheet = Record<(typeof REP_FIELDS)[number]["key"], string | null>;

function emptyRepSheet(): RepSheet {
  return Object.fromEntries(REP_FIELDS.map((f) => [f.key, null])) as RepSheet;
}
function sanitizeRepSheet(raw: any): RepSheet {
  const out = emptyRepSheet();
  if (raw && typeof raw === "object") {
    for (const f of REP_FIELDS) {
      const v = raw[f.key];
      if (typeof v === "string") {
        const t = v.trim();
        out[f.key] = t && !/^(null|n\/a|unknown|none)$/i.test(t) ? t : null;
      }
    }
  }
  return out;
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(candidate.slice(start, end + 1));
}

// Generate (or regenerate) the profile for one org.
// opts.force=true (explicit "Regenerate" button) overrides a manual edit.
export async function generateClientProfile(
  admin: SupabaseClient,
  orgId: string,
  opts: { runId?: string | null; force?: boolean } = {}
): Promise<GenerateResult> {
  const { data: org } = await admin.from("orgs").select("id, name, tenkara_org_id").eq("id", orgId).maybeSingle();
  if (!org) return { status: "no_org" };

  const { data: profile } = await admin
    .from("client_profiles")
    .select("manual_override")
    .eq("org_id", orgId)
    .maybeSingle();
  if (profile?.manual_override && !opts.force) return { status: "skipped_override" };

  const [{ data: settings }, { data: uploads }, leadsRes, draftsRes] = await Promise.all([
    admin.from("client_settings").select("outreach_mode, ghost_brand, priority_tier, primary_contact_name, primary_contact_email, sourcing_notes").eq("org_id", orgId).maybeSingle(),
    admin.from("client_uploads").select("kind, file_name, content_text").eq("org_id", orgId).order("created_at", { ascending: false }).limit(20),
    admin.from("leads_in_flight").select("id", { count: "exact", head: true }).eq("org_id", orgId),
    admin.from("draft_references").select("id", { count: "exact", head: true }).eq("org_id", orgId),
  ]);
  const oaActivity = { leads: leadsRes.count ?? 0, drafts: draftsRes.count ?? 0 };

  const tenkara = org.tenkara_org_id ? await gatherTenkaraData(org.tenkara_org_id) : null;

  const clientType = deriveClientType(settings?.outreach_mode, {
    quotes: tenkara?.quoteCount ?? 0,
    oaLeads: oaActivity.leads,
    oaDrafts: oaActivity.drafts,
  });

  let summary = "";
  let highlights: string[] = [];
  let sources: { title: string; url: string }[] = [];
  let repSheet = emptyRepSheet();

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const stream = anthropic().messages.stream({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_WEB_USES } as any],
        messages: [{ role: "user", content: buildUserMessage({ orgName: org.name, tenkara, settings, uploads: uploads ?? [], oaActivity }) }],
      });
      const res = await stream.finalMessage();
      const raw = res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
      const parsed = extractJson(raw);
      summary = typeof parsed.summary === "string" ? parsed.summary : "";
      highlights = Array.isArray(parsed.highlights) ? parsed.highlights.filter((h: any) => typeof h === "string").slice(0, 6) : [];
      sources = Array.isArray(parsed.sources)
        ? parsed.sources.filter((s: any) => s && typeof s.url === "string").map((s: any) => ({ title: String(s.title ?? s.url), url: s.url })).slice(0, 10)
        : [];
      repSheet = sanitizeRepSheet(parsed.rep_sheet);
    } catch (e: any) {
      return { status: "error", error: e.message };
    }
  } else {
    // No LLM key: deterministic fallback from internal data only.
    const matLabels = tenkara ? tenkara.materials.map((m) => m.label) : [];
    summary = tenkara
      ? `${org.name}: ${tenkara.quoteCount} quotes across ${tenkara.supplierCount} suppliers; sources ${matLabels.slice(0, 8).join(", ") || "n/a"}.`
      : `${org.name}: no Tenkara data yet.`;
    highlights = [
      `${oaActivity.leads} leads, ${oaActivity.drafts} drafts in OA`,
      tenkara ? `${tenkara.quoteCount} Tenkara quotes` : "no Tenkara record",
    ];
  }

  // Fill rep_sheet volume from internal material figures when the model left it blank.
  if (!repSheet.volume && tenkara) {
    const vols = tenkara.materials.filter((m) => m.volume).map((m) => `${m.label}: ${m.volume}`);
    if (vols.length) repSheet.volume = vols.slice(0, 8).join("; ");
  }

  const now = new Date().toISOString();
  const { error } = await admin.from("client_profiles").upsert(
    {
      org_id: orgId,
      client_type: clientType,
      summary,
      highlights,
      sources,
      rep_sheet: repSheet,
      profile: {
        tenkara: tenkara ?? null,
        oa_activity: oaActivity,
        settings: settings ?? null,
        upload_count: uploads?.length ?? 0,
      },
      manual_override: false,
      settings_synced_at: now,
      last_generated_at: now,
      last_built_at: now,
      last_run_id: opts.runId ?? null,
      updated_at: now,
    },
    { onConflict: "org_id" }
  );
  if (error) return { status: "error", error: error.message };
  return { status: "generated", clientType };
}

// Scheduled backstop: lightly refresh stale/missing profiles. Capped because
// each call hits web_search. Respects manual edits (force=false).
export async function refreshStaleClientProfiles(
  admin: SupabaseClient,
  opts: { runId?: string | null; limit?: number } = {}
): Promise<{ generated: number; skipped: number; errored: number; considered: number }> {
  const limit = opts.limit ?? 3;

  // Orgs that have any client material (settings or uploads) — candidates for a profile.
  const [{ data: withSettings }, { data: withUploads }, { data: profiles }] = await Promise.all([
    admin.from("client_settings").select("org_id"),
    admin.from("client_uploads").select("org_id"),
    admin.from("client_profiles").select("org_id, last_generated_at, manual_override"),
  ]);
  const candidates = new Set<string>();
  (withSettings ?? []).forEach((r: any) => candidates.add(r.org_id));
  (withUploads ?? []).forEach((r: any) => candidates.add(r.org_id));

  const profByOrg = new Map<string, any>((profiles ?? []).map((p: any) => [p.org_id, p]));
  const cutoff = Date.now() - STALE_DAYS * 24 * 3600 * 1000;

  const due: string[] = [];
  for (const orgId of candidates) {
    const p = profByOrg.get(orgId);
    if (p?.manual_override) continue;
    const gen = p?.last_generated_at ? new Date(p.last_generated_at).getTime() : 0;
    if (!p || gen < cutoff) due.push(orgId);
    if (due.length >= limit) break;
  }

  let generated = 0, skipped = 0, errored = 0;
  for (const orgId of due) {
    const res = await generateClientProfile(admin, orgId, { runId: opts.runId, force: false });
    if (res.status === "generated") generated++;
    else if (res.status === "skipped_override") skipped++;
    else if (res.status === "error") errored++;
  }
  return { generated, skipped, errored, considered: candidates.size };
}
