// Direct SourceReady MCP client. Replaces the container-hosted Gamut MCP proxy
// (host.docker.internal:47891) so discovery no longer depends on an out-of-band
// agent holding the connection. The upstream is an ordinary HTTPS MCP endpoint
// with a static bearer token, so it is reachable from serverless.

export class SourceReadyUnavailableError extends Error {
  constructor(status: number) {
    super(`SourceReady MCP unavailable (HTTP ${status})`);
    this.name = "SourceReadyUnavailableError";
  }
}

// A search sent with unlock_contacts against a spent contact-credit balance fails
// outright and returns NO suppliers, where the same search without it returns all
// of them. Callers retry unflagged rather than let a spent balance mean zero leads.
export class SourceReadyCreditsExceededError extends Error {
  constructor() {
    super("SourceReady contact credits exhausted (CREDITS_EXCEED_LIMIT)");
    this.name = "SourceReadyCreditsExceededError";
  }
}

export function sourceReadyConfigured(): boolean {
  return !!(process.env.SOURCEREADY_MCP_URL && process.env.SOURCEREADY_MCP_TOKEN);
}

// The endpoint answers either a plain JSON body or an SSE frame depending on the
// Accept negotiation; both carry the same JSON-RPC envelope.
function decodeEnvelope(raw: string): any {
  const text = raw.trimStart().startsWith("event:")
    ? raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5))
        .join("")
    : raw;
  return text ? JSON.parse(text) : {};
}

async function rpc(method: string, params: Record<string, any>, timeoutMs: number): Promise<any> {
  const url = process.env.SOURCEREADY_MCP_URL;
  const token = process.env.SOURCEREADY_MCP_TOKEN;
  if (!url || !token) throw new Error("SOURCEREADY_MCP_URL / SOURCEREADY_MCP_TOKEN not set");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (res.status >= 500) throw new SourceReadyUnavailableError(res.status);
    const text = await res.text();
    if (!res.ok) throw new Error(`SourceReady ${res.status}: ${text.slice(0, 300)}`);
    const body = decodeEnvelope(text);
    if (body.error) throw new Error(`SourceReady RPC error: ${JSON.stringify(body.error).slice(0, 300)}`);
    return body.result ?? {};
  } finally {
    clearTimeout(timeout);
  }
}

export interface SupplierSearchOpts {
  title: string;
  productQuery: string;
  size: number;
  page: number;
  unlockContacts?: boolean;
  timeoutMs?: number;
}

// Returns the raw markdown profile text. supplier_search_v3 answers in markdown,
// not JSON, so parsing lives with the ingest (see parseSupplierMarkdown).
export async function searchSuppliers(opts: SupplierSearchOpts): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  await rpc(
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "ops-agents", version: "1" },
    },
    30_000
  );

  const args: Record<string, any> = {
    title: opts.title,
    size: opts.size,
    page: opts.page,
    filter: { productQuery: opts.productQuery },
  };
  if (opts.unlockContacts) args.unlock_contacts = true;

  const result = await rpc("tools/call", { name: "supplier_search_v3", arguments: args }, timeoutMs);
  const text = (result.content ?? [])
    .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
    .join("\n");

  if (result.isError) {
    if (/CREDITS_EXCEED_LIMIT/i.test(text)) throw new SourceReadyCreditsExceededError();
    throw new Error(`SourceReady search failed: ${text.slice(0, 300)}`);
  }
  return text;
}
