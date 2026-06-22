// Tier pricing for marketplace leads — published price ladders captured off a
// supplier's own website (volume breaks). Stored on leads_in_flight.payload as
// `price_tiers`. Mirrors the PriceTier shape Agent 05 already uses for Tenkara
// marketplace re-checks, so the two can converge later.

export interface PriceTier {
  pack_size: string | null; // free-text, e.g. "25 kg drum", "1 lb"
  price: number | null; // total price for that pack, in USD
  unit_price: number | null; // per-unit price ($/kg, $/lb…) when derivable
}

export function sanitizeTiers(input: unknown): PriceTier[] {
  if (!Array.isArray(input)) return [];
  return input
    .slice(0, 30)
    .map((t: any) => ({
      pack_size: typeof t?.pack_size === "string" ? t.pack_size.trim().slice(0, 120) || null : null,
      price: Number.isFinite(Number(t?.price)) && t?.price !== null && t?.price !== "" ? Number(t.price) : null,
      unit_price:
        Number.isFinite(Number(t?.unit_price)) && t?.unit_price !== null && t?.unit_price !== ""
          ? Number(t.unit_price)
          : null,
    }))
    .filter((t) => t.pack_size || t.price != null || t.unit_price != null);
}
