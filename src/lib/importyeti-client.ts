// Direct ImportYeti API client. Replaces the container-hosted `query-importyeti`
// skill so discovery no longer depends on an out-of-band agent holding the key.

const BASE = "https://data.importyeti.com";

export interface ImportYetiSupplier {
  supplier_name?: string | null;
  supplier_country_code?: string | null;
  supplier_address?: string | null;
  supplier_link?: string | null;
  supplier_total_shipments?: number | string | null;
  matching_shipments?: number | string | null;
  specialization?: number | string | null;
  relevance_score?: number | string | null;
  supplier_experience?: number | string | null;
  weight?: number | string | null;
  total_customers?: number | string | null;
  customer_companies?: string[] | null;
  product_description?: string[] | null;
}

export interface ProductSuppliersResult {
  suppliers: ImportYetiSupplier[];
  creditsRemaining: number | null;
}

// ImportYeti returns 500s in bursts rather than as a clean outage. Callers treat
// this as retryable and leave the page cursor unadvanced so the page is re-pulled.
export class ImportYetiUnavailableError extends Error {
  constructor(status: number) {
    super(`ImportYeti API unavailable (HTTP ${status})`);
    this.name = "ImportYetiUnavailableError";
  }
}

export function importYetiKeyConfigured(): boolean {
  return !!process.env.IMPORTYETI_API_KEY;
}

export async function fetchProductSuppliers(
  product: string,
  opts: { pageSize: number; offset: number; excludeCountries?: string[]; timeoutMs?: number }
): Promise<ProductSuppliersResult> {
  const key = process.env.IMPORTYETI_API_KEY;
  if (!key) throw new Error("IMPORTYETI_API_KEY not set");

  const params = new URLSearchParams({
    page_size: String(opts.pageSize),
    offset: String(opts.offset),
  });
  if (opts.excludeCountries?.length) {
    params.set("exclude_countries", opts.excludeCountries.join(","));
  }

  const url = `${BASE}/v1.0/product/${encodeURIComponent(product)}/suppliers?${params}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(url, {
      headers: { IYApiKey: key },
      signal: controller.signal,
    });
    if (res.status >= 500) throw new ImportYetiUnavailableError(res.status);
    const text = await res.text();
    if (!res.ok) throw new Error(`ImportYeti ${res.status}: ${text.slice(0, 300)}`);
    const body = text ? JSON.parse(text) : {};
    return {
      suppliers: Array.isArray(body.data) ? body.data : [],
      creditsRemaining:
        typeof body.creditsRemaining === "number" ? body.creditsRemaining : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}
