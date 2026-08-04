// Dry-run the document pipeline against one or more page URLs and print what it
// finds: which links were taken as candidates, which were rejected and why, the
// classified doc type, and the fields parsed out of each file.
//
// Writes NOTHING. Use it to check extraction quality against the real document
// (open the printed doc URL and compare), and to see whether the hint gate is
// missing a link. retrieve-docs.mts is the version that stores.
//
// Run:
//   npx tsx -r dotenv/config scripts/test-doc-extract.mts --url <page> [--url <page> ...] [--max 5]
//   npx tsx -r dotenv/config scripts/test-doc-extract.mts --org california-chemicals --limit 5
import { createAdminClient } from "@/lib/supabase/admin";
import { extractDocLinks } from "@/lib/document-retrieve";
import { classifyDocType } from "@/lib/supplier-documents";
import { extractDocumentFields, isDocExtractableExt } from "@/lib/document-extract";

const argsOf = (name: string): string[] =>
  process.argv.reduce<string[]>((acc, a, i) => (a === name && process.argv[i + 1] ? [...acc, process.argv[i + 1]] : acc), []);
const argOf = (name: string): string | undefined => argsOf(name)[0];

const maxDocs = Number(argOf("--max") ?? "5");
const UA = "Mozilla/5.0 (compatible; TenkaraOpsBot/1.0; +https://ops-agents-vu4o.vercel.app)";

let targets: { pageUrl: string; label: string }[] = argsOf("--url").map((u) => ({ pageUrl: u, label: "" }));

const slug = argOf("--org");
if (slug) {
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id").eq("slug", slug).single();
  if (!org) {
    console.error(`org not found: ${slug}`);
    process.exit(1);
  }
  const { data: rows } = await admin
    .from("quote_profiles")
    .select("supplier_name, material_name, source_url")
    .eq("org_id", org.id)
    .not("source_url", "is", null)
    .limit(Number(argOf("--limit") ?? "5"));
  targets = targets.concat(
    (rows ?? [])
      .filter((r: any) => /^https?:\/\//i.test(r.source_url ?? ""))
      .map((r: any) => ({ pageUrl: r.source_url, label: `${r.material_name} @ ${r.supplier_name}` }))
  );
}

if (!targets.length) {
  console.error("usage: test-doc-extract.mts --url <page> [--url ...] | --org <slug> [--limit N]");
  process.exit(1);
}

function extOf(u: string): string {
  try {
    const p = new URL(u).pathname;
    const dot = p.lastIndexOf(".");
    return dot >= 0 ? p.slice(dot + 1).toLowerCase() : "";
  } catch {
    return "";
  }
}

async function fetchWithTimeout(url: string, accept: string, ms = 20_000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA, Accept: accept } });
  } finally {
    clearTimeout(t);
  }
}

// Every <a> whose text or href mentions a document, whether or not the pipeline
// would take it. This is what shows a miss: a real SDS link the gate dropped.
const MENTION_RE = /\b(m?sds|coa|c\.?o\.?a|tds|coo|certificate|cert|analysis|technical|data\s*sheet|datasheet|spec|safety)\b/i;
function mentionedLinks(html: string, baseUrl: string): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*?href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let abs: string;
    try {
      abs = new URL(m[1], baseUrl).toString();
    } catch {
      continue;
    }
    const text = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!MENTION_RE.test(abs) && !MENTION_RE.test(text)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ url: abs, text });
  }
  return out;
}

for (const t of targets) {
  console.log("\n" + "=".repeat(100));
  console.log(t.label ? `${t.label}\n${t.pageUrl}` : t.pageUrl);
  console.log("=".repeat(100));

  let html = "";
  try {
    const res = await fetchWithTimeout(t.pageUrl, "text/html,application/pdf,*/*");
    if (!res.ok) {
      console.log(`  page fetch ${res.status} ${res.statusText}`);
      continue;
    }
    html = await res.text();
  } catch (e: any) {
    console.log(`  page error: ${String(e?.message ?? e).slice(0, 160)}`);
    continue;
  }

  const taken = extractDocLinks(html, t.pageUrl);
  const takenSet = new Set(taken.map((l) => l.url));
  const dropped = mentionedLinks(html, t.pageUrl).filter((l) => !takenSet.has(l.url));

  console.log(`  candidates taken: ${taken.length}`);
  if (dropped.length) {
    console.log(`  mentions the pipeline did NOT take (${dropped.length}):`);
    for (const d of dropped.slice(0, 12)) {
      const ext = extOf(d.url);
      const why = !isDocExtractableExt(ext) ? (ext ? `unparseable .${ext}` : "no file extension in path") : "no doc keyword";
      console.log(`    - [${why}] "${d.text.slice(0, 60)}" ${d.url.slice(0, 110)}`);
    }
  }

  for (const link of taken.slice(0, maxDocs)) {
    const fileName = decodeURIComponent(new URL(link.url).pathname.split("/").filter(Boolean).pop() ?? "document");
    try {
      const res = await fetchWithTimeout(link.url, "application/pdf,image/*,text/*,*/*");
      if (!res.ok) {
        console.log(`\n  ${fileName}: fetch ${res.status}`);
        continue;
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = extOf(link.url) || (contentType.includes("pdf") ? "pdf" : "");
      const docType = classifyDocType(`${fileName} ${link.text}`, contentType);
      console.log(`\n  ${fileName}`);
      console.log(`    link text : "${link.text.slice(0, 70)}"`);
      console.log(`    url       : ${link.url}`);
      console.log(`    classified: ${docType}   ${(buf.byteLength / 1024).toFixed(0)} KB   ${contentType || "?"}`);
      const t0 = Date.now();
      const extracted = await extractDocumentFields(buf, docType, ext);
      if (!extracted) {
        console.log(`    parsed    : FAILED (unparseable or extractor error)`);
        continue;
      }
      console.log(`    expires_on: ${extracted.expires_on ?? "null"}   (${Date.now() - t0} ms)`);
      const entries = Object.entries(extracted.fields);
      if (!entries.length) console.log(`    fields    : {}`);
      for (const [k, v] of entries) {
        console.log(`    ${k.padEnd(22)}: ${v === null || v === undefined ? "null" : String(v).replace(/\s+/g, " ").slice(0, 90)}`);
      }
    } catch (e: any) {
      console.log(`\n  ${fileName}: error ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
}
