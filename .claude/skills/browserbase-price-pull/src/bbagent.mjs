// Call a Browserbase AGENT (native Agents API) to do the price search, instead of
// orchestrating act/observe/extract ourselves. This is the highest-abstraction
// Browserbase surface: you create a reusable Agent in the dashboard (a systemPrompt
// + resultSchema), then trigger runs here. Because the Agent carries a resultSchema,
// runs return STRUCTURED output (result.output) natively — which the Stagehand SDK
// agent could not do on this account.
//
// Docs: POST /v1/agents/runs  (agentId, task, variables, resultSchema, browserSettings)
//       GET  /v1/agents/runs/{runId}  → { status, result:{ output, summary }, sessionId }
//
// Raw fetch (no SDK version dependency). Auth header: X-BB-API-Key.

const BASE = "https://api.browserbase.com/v1";
const TERMINAL = new Set(["COMPLETED", "FAILED", "STOPPED", "TIMED_OUT"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function key() {
  const k = process.env.BROWSERBASE_API_KEY;
  if (!k) throw new Error("BROWSERBASE_API_KEY not set");
  return k;
}

async function bb(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-BB-API-Key": key(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`BB ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export async function listAgents() {
  return (await bb("/agents"))?.data ?? [];
}

// Just START a run (non-blocking). Returns { runId, agentId, sessionId, viewUrl }.
// Use this to fan out many concurrent runs, then collect them with pollRun.
export async function startRun({ agentId, task, variables, resultSchema, browserSettings } = {}) {
  if (!task) throw new Error("startRun: task required");
  const created = await bb("/agents/runs", {
    method: "POST",
    body: {
      ...(agentId ? { agentId } : {}),
      task,
      ...(variables ? { variables } : {}),
      ...(resultSchema ? { resultSchema } : {}),
      browserSettings: { proxies: true, ...(browserSettings ?? {}) },
    },
  });
  const runId = created.runId ?? created.id;
  const sid = created.sessionId ?? null;
  return { runId, agentId: created.agentId ?? agentId ?? null, sessionId: sid, viewUrl: sid ? `https://browserbase.com/sessions/${sid}` : null };
}

// Poll an already-started run to a terminal state.
export async function pollRun(runId, { maxWaitMs = 600000, pollMs = 5000, onMessage } = {}) {
  const deadline = Date.now() + maxWaitMs;
  let run;
  while (true) {
    run = await bb(`/agents/runs/${runId}`);
    if (TERMINAL.has(run.status)) break;
    if (Date.now() > deadline) {
      if (onMessage) onMessage({ event: "timeout", runId });
      break;
    }
    await sleep(pollMs);
  }
  const sid = run?.sessionId ?? null;
  return {
    runId,
    status: run?.status ?? "UNKNOWN",
    result: run?.result ?? null,
    sessionId: sid,
    viewUrl: sid ? `https://browserbase.com/sessions/${sid}` : null,
  };
}

// Start + poll a single run to completion (convenience wrapper).
export async function runAgent({ agentId, task, variables, resultSchema, browserSettings, maxWaitMs = 600000, pollMs = 5000, onMessage } = {}) {
  const started = await startRun({ agentId, task, variables, resultSchema, browserSettings });
  if (onMessage) onMessage({ event: "started", ...started });
  const done = await pollRun(started.runId, { maxWaitMs, pollMs, onMessage });
  return { ...started, ...done, viewUrl: done.viewUrl ?? started.viewUrl };
}

// Fan out MANY runs concurrently (the account now allows concurrent sessions),
// surface every session URL up front, then collect all results. items: [{key,
// task, variables}]. Shared agentId/resultSchema/browserSettings across the batch.
export async function runBatch(items, { agentId, resultSchema, browserSettings, maxWaitMs = 600000, pollMs = 5000, onMessage } = {}) {
  const started = await Promise.all(
    items.map(async (it) => {
      try {
        const s = await startRun({ agentId, task: it.task, variables: it.variables, resultSchema, browserSettings });
        if (onMessage) onMessage({ event: "started", key: it.key, ...s });
        return { ...it, ...s, error: null };
      } catch (e) {
        if (onMessage) onMessage({ event: "start-failed", key: it.key, error: String(e?.message ?? e) });
        return { ...it, runId: null, error: String(e?.message ?? e) };
      }
    }),
  );
  return await Promise.all(
    started.map(async (s) => {
      if (!s.runId) return { ...s, status: "START_FAILED", result: null };
      const done = await pollRun(s.runId, { maxWaitMs, pollMs, onMessage });
      if (onMessage) onMessage({ event: "done", key: s.key, runId: s.runId, status: done.status });
      return { ...s, ...done, viewUrl: done.viewUrl ?? s.viewUrl };
    }),
  );
}

// Map a Browserbase Agent's structured result.output to the marketplace_pull shape
// writePull expects. Tolerant of a few likely field names since the schema is
// defined agent-side. Never fabricate: if no numeric price, classify needs_review.
export function toMarketplacePull(run, { url } = {}) {
  const out = run?.result?.output ?? {};
  const summary = run?.result?.summary ?? null;

  const rawTiers = Array.isArray(out.tiers) ? out.tiers : Array.isArray(out.prices) ? out.prices : [];
  const tiers = rawTiers
    .map((t) => ({
      pack_size: t.pack_size ?? t.size ?? t.packSize ?? "",
      price: numify(t.price ?? t.amount ?? t.value),
      unit_price: numify(t.unit_price ?? t.unitPrice ?? null),
    }))
    .filter((t) => t.price != null);

  const first = tiers[0] ?? null;
  const single = numify(out.current_price ?? out.price ?? null);
  const currency = out.currency ?? (first || single != null ? "USD" : null);

  let classification = out.classification ?? null;
  const hasPrice = first != null || single != null;
  if (!classification) classification = hasPrice ? "current_price_found" : "needs_review";
  if (classification === "current_price_found" && !hasPrice) classification = "needs_review";

  return {
    classification,
    current_price: first?.price ?? single ?? null,
    currency,
    pack_size: first?.pack_size ?? out.pack_size ?? null,
    unit_price: first?.unit_price ?? null,
    tiers,
    notes: out.notes ?? summary ?? null,
    source: "browserbase_agent",
    source_url: out.source_url ?? url ?? null,
    run_id: run?.runId ?? null,
  };
}

function numify(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}
