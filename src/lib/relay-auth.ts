import { NextRequest } from "next/server";

// Shared-key auth for the read-only supplier relay (consumed by the Tenkara
// material page). Send the key as `x-api-key`. Set RELAY_API_KEY in the env.
export function checkRelayKey(request: NextRequest): boolean {
  const expected = process.env.RELAY_API_KEY;
  if (!expected) return false; // fail closed if unconfigured
  return request.headers.get("x-api-key") === expected;
}

export function relayUnauthorized() {
  return new Response(JSON.stringify({ error: "unauthorized — send header x-api-key" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
