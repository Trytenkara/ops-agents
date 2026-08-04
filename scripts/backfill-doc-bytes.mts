// Backfill stored files for supplier_documents rows recorded before migration
// 0078, when a document was a link and nothing more. Two problems to fix:
//
//   1. No bytes. Those rows can't be opened from the bench (the Tenkara
//      attachment endpoint needs a bearer token, and a supplier's own URL can
//      404 or be quietly revised), and there is no hash to notice a revision.
//   2. Wrong source_kind. source_kind arrived with 0078 defaulting to 'email',
//      so the ~97 documents scraped off product pages by scripts/retrieve-docs.mts
//      on 2026-07-31 are all mislabelled as emailed, and their supplier_issued is
//      null (reference sheets indistinguishable from supplier-issued ones).
//
// Fetches each row's own source_url rather than rescraping its page: no Claude
// extraction, no re-parse, and it covers emailed attachments too. Idempotent, so
// re-running only picks up what previously failed.
//
// Run:
//   npx tsx -r dotenv/config scripts/backfill-doc-bytes.mts [--dry-run] [--limit N]
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOC_BUCKET, storagePathFor } from "@/lib/supplier-documents";
import { uploadBinaryFile } from "@/lib/storage";
import { classifyDocOrigin } from "@/lib/document-retrieve";
import { TENKARA_INBOX_BASE } from "@/lib/tenkara";

const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dryRun = process.argv.includes("--dry-run");
const limit = Number(argOf("--limit") ?? "500");

const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const UA = "Mozilla/5.0 (compatible; TenkaraOpsBot/1.0; +https://ops-agents-vu4o.vercel.app)";

const admin = createAdminClient();

const pageHash = (url: string) => crypto.createHash("sha1").update(url).digest("hex").slice(0, 24);

// supplier_issued needs the page a document was found on, which the row itself
// doesn't record; source_message_id is 'url:' + the same hash. Rebuild the map
// from every place a page URL could have come from.
const pageByHash = new Map<string, string>();
const notePage = (u: string | null | undefined) => {
  if (u && /^https?:\/\//i.test(u)) pageByHash.set(pageHash(u), u);
};
{
  const { data } = await admin.from("document_page_scans").select("page_url").limit(5000);
  for (const r of (data ?? []) as any[]) notePage(r.page_url);
}
{
  const { data } = await admin.from("quote_profiles").select("source_url").not("source_url", "is", null).limit(5000);
  for (const r of (data ?? []) as any[]) notePage(r.source_url);
}
{
  const { data } = await admin.from("leads_in_flight").select("payload").limit(5000);
  for (const r of (data ?? []) as any[]) {
    const p = (r.payload ?? {}) as any;
    notePage(p.source_url);
    notePage(p.supplier_website);
  }
}
console.error(`page URL map: ${pageByHash.size} known page(s)`);

const { data: rows, error } = await admin
  .from("supplier_documents")
  .select("id, org_id, doc_type, file_name, content_type, source_url, source_message_id")
  .is("storage_path", null)
  .order("created_at")
  .limit(limit);
if (error) {
  console.error(`query failed: ${error.message}`);
  process.exit(1);
}

const targets = (rows ?? []) as any[];
console.error(`${targets.length} row(s) without a stored file${dryRun ? " (dry run)" : ""}\n`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchOnce(url: string, headers: Record<string, string>): Promise<Buffer | { err: string; status: number }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers });
    if (!res.ok) return { err: `HTTP ${res.status}`, status: res.status };
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_BYTES) return { err: `too large (${ab.byteLength} bytes)`, status: 0 };
    if (!ab.byteLength) return { err: "empty response", status: 0 };
    return Buffer.from(ab);
  } catch (e: any) {
    return { err: String(e?.message ?? e).slice(0, 80), status: 0 };
  } finally {
    clearTimeout(t);
  }
}

// Tenkara's attachment endpoint rate-limits a sweep like this one, and a 429 is
// the one failure here that says nothing about the document. Back off and retry
// rather than recording it as a document we could not get.
async function fetchBytes(url: string, headers: Record<string, string>): Promise<Buffer | { err: string }> {
  const delays = [0, 4_000, 12_000, 30_000];
  let last: { err: string; status: number } = { err: "not attempted", status: 0 };
  for (const d of delays) {
    if (d) await sleep(d);
    const got = await fetchOnce(url, headers);
    if (got instanceof Buffer) return got;
    last = got;
    if (got.status !== 429) break;
  }
  return { err: last.err };
}

let stored = 0;
let relabelled = 0;
const failures: string[] = [];

for (const r of targets) {
  const isWeb = typeof r.source_message_id === "string" && r.source_message_id.startsWith("url:");
  const pageUrl = isWeb ? pageByHash.get(r.source_message_id.slice(4)) : undefined;
  const sourceKind = isWeb ? "web" : "email";
  // An emailed attachment came from the supplier by definition. A scraped one
  // depends on which host served it, and with the page unknown we leave it null
  // (which counts, matching how these rows behaved before 0078) rather than
  // guessing a value the bench would act on.
  const supplierIssued = isWeb ? (pageUrl ? classifyDocOrigin(r.source_url ?? "", pageUrl) : null) : true;

  let url: string | null = null;
  let headers: Record<string, string> = { "User-Agent": UA };
  if (/^https?:\/\//i.test(r.source_url ?? "")) {
    url = r.source_url;
  } else if (r.source_url?.startsWith("/api/external/attachments/")) {
    const token = process.env.TENKARA_API_TOKEN;
    if (token) {
      url = `${TENKARA_INBOX_BASE}${r.source_url}`;
      headers = { Authorization: `Bearer ${token}` };
    }
  }

  const label = `${(r.file_name ?? "?").slice(0, 52)} [${r.doc_type}/${sourceKind}]`;

  if (dryRun) {
    console.error(`  ${url ? "would fetch" : "NO URL   "} ${label}`);
    continue;
  }

  // Labels are correct regardless of whether the file is still reachable, and a
  // mislabelled row is actively misleading, so write them either way.
  const patch: Record<string, any> = { source_kind: sourceKind, supplier_issued: supplierIssued };

  if (url) {
    const got = await fetchBytes(url, headers);
    if (got instanceof Buffer) {
      const sha = crypto.createHash("sha256").update(got).digest("hex");
      const path = storagePathFor(r.org_id, sha, r.file_name);
      try {
        await uploadBinaryFile({
          bucket: DOC_BUCKET,
          path,
          content: got,
          contentType: r.content_type || "application/octet-stream",
        });
        patch.storage_path = path;
        patch.content_sha256 = sha;
        patch.retrieved_at = new Date().toISOString();
        patch.size_bytes = got.byteLength;
      } catch (e: any) {
        failures.push(`${label}: upload failed (${String(e?.message ?? e).slice(0, 60)})`);
      }
    } else {
      failures.push(`${label}: ${got.err}`);
    }
  } else {
    failures.push(`${label}: no fetchable URL`);
  }

  const { error: upErr } = await admin.from("supplier_documents").update(patch).eq("id", r.id);
  if (upErr) {
    failures.push(`${label}: update failed (${upErr.message})`);
    continue;
  }
  relabelled++;
  if (patch.storage_path) {
    stored++;
    console.error(`  OK  ${label} ${patch.size_bytes} bytes`);
  }
}

if (!dryRun) {
  console.error(`\n${stored} file(s) stored, ${relabelled} row(s) relabelled, ${failures.length} failure(s)`);
  // A document that no longer downloads is exactly the case stored bytes exist
  // to prevent, so name each one instead of reporting a count.
  for (const f of failures.slice(0, 60)) console.error(`  -- ${f}`);
  if (failures.length > 60) console.error(`  ... and ${failures.length - 60} more`);
}
