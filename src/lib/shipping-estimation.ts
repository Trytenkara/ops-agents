import { Anthropic } from "@anthropic-ai/sdk";
import type { PriceTier } from "./price-tiers";
import { resolveDensity, type DensityIndex } from "./material-density";

const client = new Anthropic();

// Estimate shipping costs for non-MOQ tiers based on the actual MOQ shipping cost
// and the weight/volume differences between tiers. Uses Claude Haiku for inference.
export async function estimatePerTierShipping(
  shippingCostMoq: number,
  priceTiers: PriceTier[],
  materialName: string,
  densities: DensityIndex,
): Promise<Record<number, number | null>> {
  if (priceTiers.length <= 1) {
    // Only one tier, no estimation needed
    return {};
  }

  // Build a tier summary with weights/volumes if available
  const tierSummary = priceTiers.map((t, i) => {
    const breakdown = extractWeightInfo(t, resolveDensity(densities, materialName)?.density ?? null);
    return {
      index: i,
      pack_size: t.pack_size ?? "unknown",
      case_size: t.case_size,
      unit_of_measurement: t.unit_of_measurement,
      estimated_weight_kg: breakdown.weight_kg,
      is_moq: i === 0,
    };
  });

  const prompt = `You are estimating shipping costs for different pack sizes of a material based on a known shipping cost for the MOQ (minimum order quantity).

Material: ${materialName}

MOQ tier (index 0):
- Pack size: ${tierSummary[0]?.pack_size || "unknown"}
- Estimated weight: ${tierSummary[0]?.estimated_weight_kg ? `${tierSummary[0].estimated_weight_kg} kg` : "unknown"}
- Actual shipping cost: $${shippingCostMoq.toFixed(2)} USD

Other tiers:
${tierSummary
  .slice(1)
  .map(
    (t) =>
      `- Index ${t.index}: ${t.pack_size} (${t.estimated_weight_kg ? `~${t.estimated_weight_kg} kg` : "unknown weight"})`,
  )
  .join("\n")}

Rules:
1. Estimate shipping cost for each tier as a linear function of weight (cost scales proportionally with weight/volume)
2. If weight data is missing for a tier, return null for that tier
3. Round to 2 decimal places
4. Assume shipping origin is USA, destination varies by org
5. Never estimate wildly outside the MOQ tier's cost (e.g., 10x larger tier should not be 50x the cost)

Return ONLY valid JSON with no prose:
{"1": 25.50, "2": 35.00, "3": null, ...}
Where keys are tier indices (as strings) and values are estimated costs in USD or null.`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const text = (response.content[0] as { type: "text"; text: string })?.text;
    if (!text) return {};

    // Claude may wrap JSON in markdown code blocks, extract it
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};

    const estimates = JSON.parse(jsonMatch[0]);
    const result: Record<number, number | null> = {};

    for (const [key, value] of Object.entries(estimates)) {
      const idx = parseInt(key, 10);
      if (!isNaN(idx) && idx > 0 && idx < priceTiers.length) {
        result[idx] = typeof value === "number" ? value : null;
      }
    }

    return result;
  } catch (error) {
    console.error("Shipping estimation failed:", error);
    return {};
  }
}

// Helper: extract weight info from a tier's pack_size string
// Returns estimated weight in kg, or null if unextractable
/**
 * PRICING-05 / DATA-07. A litre is not a kilogram. This used to convert every
 * volumetric pack at water density, so a 200 L drum of a 1.84 g/ml acid was
 * estimated at 200 kg instead of 368 and the per-tier shipping came out nearly
 * half what it should be — a fabricated weight producing a fabricated cost that
 * reads like a captured one.
 *
 * `densityGml` comes from the material density index, which matches on an exact
 * name for the same reason. Unknown density means no weight, and the estimator
 * is told to return null for that tier rather than guess.
 */
function extractWeightInfo(
  tier: PriceTier,
  densityGml: number | null,
): { weight_kg: number | null; volume_l: number | null } {
  if (!tier.pack_size || !tier.case_size) {
    return { weight_kg: null, volume_l: null };
  }

  const caseSize = tier.case_size;
  const unit = tier.unit_of_measurement?.toLowerCase();

  let weight_kg: number | null = null;
  let volume_l: number | null = null;

  // Convert common units to kg or L for comparison
  if (unit === "kg") {
    weight_kg = caseSize;
  } else if (unit === "lb") {
    weight_kg = caseSize * 0.453592; // 1 lb = 0.453592 kg
  } else if (unit === "g") {
    weight_kg = caseSize / 1000;
  } else if (unit === "ton") {
    weight_kg = caseSize * 1000;
  } else if (unit === "l" || unit === "liter" || unit === "litre") {
    volume_l = caseSize;
    weight_kg = densityGml == null ? null : caseSize * densityGml;
  } else if (unit === "ml" || unit === "milliliter") {
    volume_l = caseSize / 1000;
    weight_kg = densityGml == null ? null : (caseSize / 1000) * densityGml;
  } else if (unit === "gal" || unit === "gallon") {
    // 1 gallon ≈ 3.785 liters
    volume_l = caseSize * 3.785;
    weight_kg = densityGml == null ? null : caseSize * 3.785 * densityGml;
  } else if (unit === "oz" || unit === "ounce") {
    weight_kg = (caseSize * 28.3495) / 1000; // 1 oz ≈ 28.3495 grams
  }

  return { weight_kg, volume_l };
}
