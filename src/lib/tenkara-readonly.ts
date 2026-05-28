import { Pool, type PoolClient } from "pg";

// Read-only client to the Tenkara prod Supabase. Tuned for serverless:
// - Transaction pooler (port 6543) is preferred; session pooler (5432) can
//   hang in Vercel functions because connections don't survive invocations.
// - max:1 so we never queue waiting on ourselves.
// - JS-side 25s timeout per query so a stuck connection fails fast instead of
//   eating the whole 300s function budget.
// - statement_timeout=20s on the server side as a belt-and-suspenders.

const REQUIRED_USERNAME_PREFIX = "mcp_readonly.";
const QUERY_TIMEOUT_MS = 25_000;

let pool: Pool | null = null;

function buildPool(): Pool {
  const raw = process.env.TENKARA_READONLY_DATABASE_URL;
  if (!raw) {
    throw new Error("TENKARA_READONLY_DATABASE_URL is not set. Add the mcp_readonly connection string from the tenkara-supabase-setup skill.");
  }
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("TENKARA_READONLY_DATABASE_URL is not a valid URL"); }
  if (!parsed.username || !parsed.username.startsWith(REQUIRED_USERNAME_PREFIX)) {
    const detail = `username="${parsed.username}" — expected prefix "${REQUIRED_USERNAME_PREFIX}"`;
    void (async () => {
      try {
        const { alertTenkaraWriteAttempt } = await import("@/lib/safety-alerts");
        await alertTenkaraWriteAttempt(detail);
      } catch (e) { console.error("[safety-alerts] tenkara write-attempt alert failed:", e); }
    })();
    throw new Error(
      `TENKARA_READONLY_DATABASE_URL must use the mcp_readonly role (username starts with "${REQUIRED_USERNAME_PREFIX}"); ` +
      `got "${parsed.username}". Refusing to connect to avoid accidental writes.`
    );
  }
  if (!parsed.searchParams.has("statement_timeout")) {
    parsed.searchParams.set("statement_timeout", "20000");
  }
  return new Pool({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Pool poisoning guard: when a Vercel invocation is killed mid-query, the
// max:1 pool's only connection stays in a hung state and the next invocation
// reuses it and hangs again. Force-destroy the pool on any failure so the
// next call rebuilds from scratch.
async function destroyPool() {
  if (!pool) return;
  const dying = pool;
  pool = null;
  try { await withTimeout(dying.end(), 2_000, "pool.end"); } catch { /* best-effort */ }
}

export async function tenkaraQuery<T extends Record<string, any> = Record<string, any>>(text: string, params: any[] = []): Promise<T[]> {
  if (!pool) pool = buildPool();
  try {
    const { rows } = await withTimeout(pool.query<T>(text, params), QUERY_TIMEOUT_MS, "tenkara query");
    return rows;
  } catch (e) {
    await destroyPool();
    throw e;
  }
}

export async function withTenkaraClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if (!pool) pool = buildPool();
  let client: PoolClient;
  try {
    client = await withTimeout(pool.connect(), 8_000, "tenkara connect");
  } catch (e) {
    await destroyPool();
    throw e;
  }
  try {
    return await fn(client);
  } catch (e) {
    try { client.release(true); } catch { /* ignore */ }
    await destroyPool();
    throw e;
  } finally {
    try { client.release(); } catch { /* already released on error path */ }
  }
}
