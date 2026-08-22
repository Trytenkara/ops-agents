import type { SupabaseClient } from "@supabase/supabase-js";
import { getClientShipTo } from "@/lib/tenkara-client-settings";

export interface ShipToDestination {
  country: string;
  state: string;
  city: string;
  zip: string;
}

/**
 * The destination a delivery cost is quoted to, or null if the client has not
 * configured one.
 *
 * PRICING-04. This used to select `ship_to_*` off `orgs`, where those columns
 * do not exist. PostgREST answers that with an error rather than empty columns,
 * the error was swallowed, and every caller read the null as "this client has
 * no ship-to" — so the whole feature was inert for weeks: 4,044 listings pulled,
 * zero delivery-cost attempts, and a capture rate that never looked wrong
 * because nothing was ever attempted. The addresses live on
 * `client_tenkara_settings`, mirrored hourly from Tenkara by Agent 12, and are
 * read here through the one accessor that owns that table so a second idea of
 * where a ship-to lives cannot grow back.
 */
export async function getOrgShipToAddress(
  admin: SupabaseClient,
  orgId: string,
): Promise<ShipToDestination | null> {
  if (!orgId) return null;
  const settings = await getClientShipTo(admin, orgId);
  if (!settings?.parts) return null;
  const { city, state, zip, country } = settings.parts;
  // A cost quoted to a country alone is not the client's landed cost. Requiring
  // enough of the address to reach a real checkout is PRICING-03: no
  // destination means no attempt, never an attempt against a guess.
  if (!zip && !(city && state)) return null;
  return {
    country: country || "United States",
    state: state || "",
    city: city || "",
    zip: zip || "",
  };
}

/**
 * Format a destination for a checkout form.
 *
 * PRICING-03/05. This used to return a hard-coded Los Angeles address when it
 * was handed null, which is a fabricated destination: any cost read back would
 * have been a real number quoted to somewhere the client does not ship. Null in
 * means null out, and the caller declines to attempt.
 */
export function formatAddressForCheckout(
  address: ShipToDestination | null,
): { formatted: string; components: Record<string, string> } | null {
  if (!address) return null;
  const parts = [address.city, address.state, address.zip, address.country].filter(Boolean);
  return { formatted: parts.join(", "), components: { ...address } };
}
