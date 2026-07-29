import { normalizePack } from "@/lib/marketplace-case-dims";
import { computeCaseDimensions } from "@/lib/case-dimensions";

// Server-only: keep marketplace_case_dims warm. Kept OUT of marketplace-case-dims.ts
// so that file stays free of server/LLM imports and client components can use its
// pure helpers. Called from Agent 05 after it writes price tiers.
//
// Cost control: one indexed `.in()` lookup skips every pack size already cached
// (the common case, since the cache is shared across all leads/clients), so only
// genuinely-new normalized pack strings ever cost an LLM call. Best-effort — any
// failure is swallowed so the price pull is never blocked.

type Admin = { from: (t: string) => any };

export async function ensureMarketplaceCaseDims(
  admin: Admin,
  packSizes: (string | null | undefined)[]
): Promise<void> {
  const wanted = new Map<string, string>(); // norm -> sample raw
  for (const ps of packSizes) {
    const n = normalizePack(ps);
    if (n && !wanted.has(n)) wanted.set(n, ps ?? "");
  }
  if (!wanted.size) return;

  try {
    const { data } = await admin
      .from("marketplace_case_dims")
      .select("pack_size_norm")
      .in("pack_size_norm", Array.from(wanted.keys()));
    const have = new Set((data ?? []).map((r: any) => r.pack_size_norm));

    for (const [norm, sample] of wanted) {
      if (have.has(norm)) continue;
      const res = await computeCaseDimensions({
        materialName: "generic dry/bulk chemical or food ingredient (material-agnostic estimate)",
        caseSize: sample,
      });
      if (!res) continue;
      await admin.from("marketplace_case_dims").upsert(
        {
          pack_size_norm: norm,
          case_type: res.case_type,
          case_dimensions: res.case_dimensions,
          dim_source: "ai_estimated",
          sample_raw: sample,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "pack_size_norm" }
      );
    }
  } catch {
    // best-effort: never block the price pull on a cache miss
  }
}
