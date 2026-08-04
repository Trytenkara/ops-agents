import crypto from "crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import { classifyDocType, insertSupplierDocuments, type SupplierDocumentInput } from "@/lib/supplier-documents";
import { extractDocumentFields, isDocExtractableExt } from "@/lib/document-extract";

// Retrieve supplier qualification documents (SDS / CoA / TDS / spec / cert) from
// a PRODUCT or SUPPLIER page URL, parse them with the same extractor the inbound
// email path uses, and store them in supplier_documents. This closes the gap the
// email pipeline left: documentation published on a product page (not emailed as
// an attachment) never reached the "bench". Read-only against the web, OA-only
// writer. Never blocks: any per-doc failure is skipped, not thrown.

type Admin = ReturnType<typeof createAdminClient>;

// A link is a candidate document only if BOTH its file type is one we can parse
// (pdf/txt/csv/image — same set as the email extractor) AND its href or link
// text signals a qualification doc. The hint gate keeps us from vacuuming every
// PDF on a page (catalogs, brochures, invoices) — only SDS/CoA/TDS-shaped links.
const DOC_HINT_RE =
  /\b(m?sds|coa|c\.?o\.?a|tds|coo|certificate|cert|analysis|technical\s*data|data\s*sheet|datasheet|spec(?:ification)?\s*sheet|safety\s*data|safety\s*sheet)\b/i;

// Storefront, CDN, and PIM hosts that serve a supplier's OWN files under someone
// else's domain. Without this list a Shopify seller's own SDS on cdn.shopify.com
// reads as third-party, which is the opposite of the truth.
const STOREFRONT_CDN_RE =
  /(^|\.)(shopify|shopifycdn|myshopify|bigcommerce|squarespace-cdn|wixstatic|demandware\.net|shoplightspeed|volusion|3dcart|woocommerce|plytix|salsify|syndigo|akeneo|contentful)\.(com|net|io)$|(^|\.)(cloudfront\.net|amazonaws\.com|rocketcdn\.me|akamaized\.net|cdn77\.org|b-cdn\.net|blob\.core\.windows\.net|storage\.googleapis\.com)$/i;

// Third-party chemical reference databases. A substance SDS from one of these is
// real chemistry but it is not this vendor issuing a document, so it must not
// satisfy a client's pre-order requirement. This is the list that decides
// supplier_issued=false; everything unrecognised stays null.
const REFERENCE_DB_RE =
  /(^|\.)(chemicalbook|sigmaaldrich|merckmillipore|fishersci|thermofisher|guidechem|echemi|chemnet|lookchem|molbase|chemspider|pubchem|nih\.gov|cdc\.gov|osha\.gov|epa\.gov|ilo\.org|inchem\.org|chemblink|chemicalsafety|msdsonline|verisk3e|ehs\.com)\.(com|cn|net|org|gov|de)?$/i;

function registrableRoot(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  return parts.length > 2 ? parts.slice(-2).join(".") : parts.join(".");
}

// Who issued this document: true for the supplier themselves, false for a
// third-party reference database, null when the host says neither.
//
// Null rather than false is the important part. The first version treated any
// off-site host as third-party, which flagged Wholesale Supplies Plus's own SDS
// files on their PIM host and would have quietly stopped them counting. The
// vendors that host a supplier's files are a long tail; the reference databases
// are a short list. So only that short list produces a false, and an unknown
// host is left for a human, since null still counts.
export function classifyDocOrigin(docUrl: string, pageUrl: string): boolean | null {
  try {
    const dh = new URL(docUrl).host;
    const ph = new URL(pageUrl).host;
    if (registrableRoot(dh) === registrableRoot(ph)) return true;
    if (STOREFRONT_CDN_RE.test(dh)) return true;
    if (REFERENCE_DB_RE.test(dh)) return false;
    return null;
  } catch {
    return null;
  }
}

const FETCH_TIMEOUT_MS = 20_000;
const UA =
  "Mozilla/5.0 (compatible; TenkaraOpsBot/1.0; +https://ops-agents-vu4o.vercel.app)";

export interface DocRetrieveTarget {
  orgId: string;
  pageUrl: string;
  supplierId?: string | null;
  supplierName?: string | null;
  materialId?: string | null;
}

export interface DocRetrieveResult {
  pageUrl: string;
  candidates: number;
  inserted: number;
  skippedDuplicates: number;
  // Rows that already existed link-only and just got their stored bytes.
  healed: number;
  errors: number;
  // Documents fetched and stored, but whose fields could not be parsed.
  extractFailures: number;
  docs: { url: string; docType: string; expiresOn: string | null }[];
  note?: string;
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

function fileNameOf(u: string): string {
  try {
    const p = new URL(u).pathname;
    return decodeURIComponent(p.split("/").filter(Boolean).pop() ?? "") || "document";
  } catch {
    return "document";
  }
}

async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA, Accept: accept } });
  } finally {
    clearTimeout(t);
  }
}

// Pull candidate document links out of raw HTML. Resolves relative hrefs against
// the page URL and de-dupes. Text is used both for the hint match and as a
// fallback filename when the href has no extension in its path.
export function extractDocLinks(html: string, baseUrl: string): { url: string; text: string }[] {
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
    const ext = extOf(abs);
    const hinted = DOC_HINT_RE.test(abs) || DOC_HINT_RE.test(text);
    if (!hinted) continue;
    if (!isDocExtractableExt(ext)) continue; // only types the extractor can read
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ url: abs, text });
  }
  return out;
}

// Stable synthetic message id so re-runs of the same page dedupe in
// insertSupplierDocuments (which keys on source_message_id + file + doc_type).
function syntheticMessageId(pageUrl: string): string {
  return "url:" + crypto.createHash("sha1").update(pageUrl).digest("hex").slice(0, 24);
}

export async function retrieveDocumentsFromUrl(
  admin: Admin,
  target: DocRetrieveTarget,
  opts: { maxDocs?: number } = {}
): Promise<DocRetrieveResult> {
  const maxDocs = opts.maxDocs ?? 10;
  const result: DocRetrieveResult = {
    pageUrl: target.pageUrl,
    candidates: 0,
    inserted: 0,
    skippedDuplicates: 0,
    healed: 0,
    errors: 0,
    extractFailures: 0,
    docs: [],
  };

  let links: { url: string; text: string }[] = [];
  try {
    const res = await fetchWithTimeout(target.pageUrl, "text/html,application/pdf,*/*");
    if (!res.ok) {
      result.note = `page fetch ${res.status}`;
      return result;
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ct.includes("application/pdf") || extOf(target.pageUrl) === "pdf") {
      // The URL itself is a document (e.g. source_url points straight at an SDS).
      links = [{ url: target.pageUrl, text: fileNameOf(target.pageUrl) }];
    } else {
      const html = await res.text();
      links = extractDocLinks(html, target.pageUrl);
    }
  } catch (e: any) {
    result.note = `page error: ${String(e?.message ?? e).slice(0, 120)}`;
    return result;
  }

  links = links.slice(0, maxDocs);
  result.candidates = links.length;
  if (!links.length) {
    result.note = "no document links found";
    return result;
  }

  const messageId = syntheticMessageId(target.pageUrl);
  const rows: SupplierDocumentInput[] = [];
  for (const link of links) {
    try {
      const res = await fetchWithTimeout(link.url, "application/pdf,image/*,text/*,*/*");
      if (!res.ok) {
        result.errors++;
        continue;
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = extOf(link.url) || (contentType.includes("pdf") ? "pdf" : "");
      const fileName = fileNameOf(link.url);
      const docType = classifyDocType(`${fileName} ${link.text}`, contentType);
      // Field parsing is a bonus; the file is the point. Anthropic rejects some
      // real PDFs outright (encrypted, malformed, oversize), and when that
      // throws inside the download's try block the document itself was being
      // thrown away with it. Isolated so a parse failure costs only the fields.
      let extracted: Awaited<ReturnType<typeof extractDocumentFields>> = null;
      try {
        extracted = await extractDocumentFields(buf, docType, ext);
      } catch {
        result.extractFailures++;
      }
      rows.push({
        orgId: target.orgId,
        supplierId: target.supplierId ?? null,
        supplierName: target.supplierName ?? null,
        materialId: target.materialId ?? null,
        docType,
        fileName,
        contentType: contentType || null,
        sizeBytes: buf.byteLength,
        sourceMessageId: messageId,
        sourceUrl: link.url,
        extracted: extracted?.fields ?? null,
        expiresOn: extracted?.expires_on ?? null,
        bytes: buf,
        sourceKind: "web",
        supplierIssued: classifyDocOrigin(link.url, target.pageUrl),
      });
      result.docs.push({ url: link.url, docType, expiresOn: extracted?.expires_on ?? null });
    } catch {
      result.errors++;
    }
  }

  const ins = await insertSupplierDocuments(admin, rows);
  result.inserted = ins.inserted;
  result.skippedDuplicates = ins.skippedDuplicates;
  result.healed = ins.healed;
  result.errors += ins.errors;
  return result;
}
