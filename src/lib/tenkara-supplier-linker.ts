import { tenkaraQuery } from "@/lib/tenkara-readonly";

// Fuzzy match a supplier name against Tenkara's suppliers table and return
// the supplier ID if found. Used at discovery time to link name-only suppliers
// from external sources (ImportYeti, SourceReady, Scout) to their Tenkara IDs
// so quotes can be exported with supplier_id populated.
//
// Algorithm:
// 1. Exact match (case-insensitive) on supplier name
// 2. If not found, try normalized name (strip punctuation, handle "Inc" variants)
// 3. Return supplier_id if matched, null otherwise

interface TenkaraSupppler {
  id: string;
  name: string;
}

const normName = (s: string | null | undefined): string => {
  if (!s) return "";
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "") // strip punctuation
    .replace(/\s+/g, " ") // normalize whitespace
    .trim();
};

// Cache of Tenkara suppliers to avoid repeated queries. Keyed by normalized name.
let _supplierCache: Map<string, string | null> | null = null;

async function loadSupplierCache(): Promise<Map<string, string | null>> {
  if (_supplierCache) return _supplierCache;

  const cache = new Map<string, string | null>();
  try {
    const suppliers = await tenkaraQuery<TenkaraSupppler>(
      `SELECT id, name FROM public.suppliers ORDER BY name`
    );
    for (const s of suppliers) {
      const key = normName(s.name);
      if (key && !cache.has(key)) {
        cache.set(key, s.id);
      }
    }
    _supplierCache = cache;
  } catch (e) {
    // If Tenkara query fails, return empty cache rather than blocking discovery
    console.error("Failed to load Tenkara supplier cache:", e);
    _supplierCache = new Map();
  }
  return _supplierCache;
}

export async function resolveSupplierIdByName(
  supplierName: string | null | undefined
): Promise<string | null> {
  if (!supplierName) return null;

  const cache = await loadSupplierCache();
  const key = normName(supplierName);
  if (!key) return null;

  // Exact match on normalized name
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // No match found
  return null;
}

// Clear cache — use sparingly, e.g. if Tenkara schema changes
export function clearSupplierCache() {
  _supplierCache = null;
}
