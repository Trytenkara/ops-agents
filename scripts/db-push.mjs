#!/usr/bin/env node
// Apply SQL migrations in supabase/migrations/ in order.
// Usage: OA_DATABASE_URL=... node scripts/db-push.mjs
// Idempotent for our migrations — they use `create table if not exists`, `drop policy if exists`,
// `on conflict do nothing`, etc. We do not maintain a migration history table for v1.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "dotenv/config";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "supabase", "migrations");

const url = process.env.OA_DATABASE_URL;
if (!url) {
  console.error("OA_DATABASE_URL not set. Add it to .env.local.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) {
  process.stdout.write(`applying ${f} ... `);
  const sql = await readFile(join(migrationsDir, f), "utf8");
  try {
    await client.query(sql);
    console.log("ok");
  } catch (e) {
    console.log("FAILED");
    console.error(e.message);
    process.exit(1);
  }
}

await client.end();
console.log("done.");
