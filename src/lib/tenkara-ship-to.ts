import type { PostgrestSingleResponse } from "@supabase/supabase-js";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

// Fetch the ship-to address for an org from Tenkara's orgs table
export async function getOrgShipToAddress(
  admin: Admin,
  tenkaraOrgId: string,
): Promise<{ country: string; state: string; city: string; zip: string } | null> {
  if (!tenkaraOrgId) return null;

  try {
    // Query Tenkara's orgs table for the configured shipping address
    // Expected fields: ship_to_address (JSON object) or ship_to_* (separate fields)
    const { data: org, error } = (await admin
      .from("orgs")
      .select("ship_to_address, ship_to_country, ship_to_state, ship_to_city, ship_to_zip")
      .eq("id", tenkaraOrgId)
      .single()) as PostgrestSingleResponse<any>;

    if (error || !org) {
      return null;
    }

    // Handle both struct formats: JSON object or separate fields
    if (org.ship_to_address && typeof org.ship_to_address === "object") {
      return {
        country: org.ship_to_address.country || "United States",
        state: org.ship_to_address.state || "",
        city: org.ship_to_address.city || "",
        zip: org.ship_to_address.zip || "",
      };
    }

    // Fallback to separate fields
    if (org.ship_to_country || org.ship_to_state || org.ship_to_city || org.ship_to_zip) {
      return {
        country: org.ship_to_country || "United States",
        state: org.ship_to_state || "",
        city: org.ship_to_city || "",
        zip: org.ship_to_zip || "",
      };
    }

    return null;
  } catch (error) {
    console.error(`Failed to fetch ship-to address for org ${tenkaraOrgId}:`, error);
    return null;
  }
}

// Format address object into a readable string for checkout forms
export function formatAddressForCheckout(
  address: { country: string; state: string; city: string; zip: string } | null,
): { formatted: string; components: Record<string, string> } {
  if (!address) {
    // Return a safe default US address for testing
    const defaultAddr = {
      country: "United States",
      state: "CA",
      city: "Los Angeles",
      zip: "90001",
    };
    return {
      formatted: `${defaultAddr.city}, ${defaultAddr.state}, ${defaultAddr.zip}, ${defaultAddr.country}`,
      components: defaultAddr,
    };
  }

  const parts = [address.city, address.state, address.zip, address.country].filter(Boolean);
  return {
    formatted: parts.join(", "),
    components: address,
  };
}
