// Fleet-wide org scoping. When set, every agent restricts its work to the listed
// client orgs (matched on Tenkara `organizations.name`, which the OA `orgs.name`
// mirrors). Used to confine the fleet to a subset of orgs during a test rollout
// without touching per-agent code. ONLY_ORG is the fleet-wide value; QR_ONLY_ORG
// is the original quote-revalidation flag, still honored for backwards
// compatibility. The value is a comma-separated list of exact org names, so the
// fleet can run several orgs in isolation (e.g. "Tenkara (Internal Sourcing),California Chemicals").

// Parsed list of in-scope org names. Empty = no scoping (fleet works all orgs).
export function onlyOrgNames(): string[] {
  const raw = process.env.ONLY_ORG?.trim() || process.env.QR_ONLY_ORG?.trim() || "";
  return raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
}

// Human-readable label for logs/summaries; null when scoping is off.
export function onlyOrgLabel(): string | null {
  const names = onlyOrgNames();
  return names.length ? names.join(", ") : null;
}

// Back-compat single-name accessor. Returns the first in-scope org, or null.
// Prefer onlyOrgNames()/matchesOnlyOrg() — this only holds the first entry.
export function onlyOrgName(): string | null {
  return onlyOrgNames()[0] ?? null;
}
