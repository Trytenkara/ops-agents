// Fleet-wide org scoping. When set, every agent restricts its work to a single
// client org (matched on Tenkara `organizations.name`, which the OA `orgs.name`
// mirrors). Used to confine the fleet to one org during a test rollout without
// touching per-agent code. ONLY_ORG is the fleet-wide name; QR_ONLY_ORG is the
// original quote-revalidation flag, still honored for backwards compatibility.
export function onlyOrgName(): string | null {
  return process.env.ONLY_ORG?.trim() || process.env.QR_ONLY_ORG?.trim() || null;
}
