import { tenkaraQuery } from "@/lib/tenkara-readonly";

// Materials the client supplies themselves. The client owns this switch on the
// Tenkara material form (both "add material" and the material settings page
// write materials.self_supplied), and it means "we already have this, don't
// source it": no discovery, no enrichment, no new outreach, no price pull.
//
// DISC-09. The answer has three states, not two, and the middle one is the
// whole point: the client makes it, the client does not make it, and we could
// not ask. Resolving "could not ask" to an empty set silently sources every
// self-supplied material the moment Tenkara times out — and it does time out.
// So the lookup reports whether it knows, and a caller that does not know
// stops rather than sources. tenkaraQuery already retries three times against
// a fresh pool, so `known: false` means a real outage, and the next pass (a
// minute to an hour away) picks the work back up.
//
// `known: true` with an empty set is a real answer — the client makes nothing
// themselves — and must not be confused with not knowing.

export type SelfSuppliedLookup =
  | { known: true; ids: Set<string> }
  | { known: false; reason: string };

export async function loadSelfSuppliedMaterials(): Promise<SelfSuppliedLookup> {
  try {
    const rows = await tenkaraQuery<{ id: string }>(
      `select id::text as id from public.materials where self_supplied is true`
    );
    return { known: true, ids: new Set(rows.map((r) => r.id)) };
  } catch (e: any) {
    return { known: false, reason: e?.message ?? String(e) };
  }
}

/** What a caller says when it stops because the lookup could not be made. */
export function selfSuppliedUnavailable(reason: string): string {
  return `Self-supplied lookup unavailable (${reason}); stopping this pass rather than working a material the client may supply themselves`;
}
