// One client's outreach may never land on another client's conversation.
//
// Tenkara treats `external_id` as an idempotency key: create a conversation with
// an id it has already seen and it hands back the EXISTING conversation and
// draft instead of making a new one. Agent 04 built that id from supplier +
// material set only, so California Chemicals and the Sierra ghost brand asking
// the same supplier about the same material produced the same key. The second
// client silently adopted the first client's conversation and draft: one Tenkara
// draft shared by two orgs, and an operator looking at another client's copy.
//
// The invariant is positive, not a list of known-bad cases: an idempotency key
// is org-scoped, always. Enforced inside `stageDraft`, so no caller can forget,
// and supplier grouping uses the same helper so a group can never span orgs.

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const ORG_SCOPE_MARKER = "--org-";

// Suffix an external/idempotency key with the org it belongs to. Idempotent: a
// key that already carries a scope is returned unchanged, so re-staging the same
// draft does not keep minting new conversations.
export function orgScopedExternalId(orgId: string | null | undefined, externalId: string): string {
  if (externalId.includes(ORG_SCOPE_MARKER)) return externalId;
  return `${externalId}${ORG_SCOPE_MARKER}${shortHash(orgId ?? "no-org")}`;
}

// Grouping/dedup key that cannot merge two clients' leads. Use this anywhere a
// Map is keyed on a supplier, an email address or a material.
export function orgScopedKey(orgId: string | null | undefined, ...parts: (string | null | undefined)[]): string {
  return [orgId ?? "no-org", ...parts.map((p) => p ?? "")].join(":");
}

export interface OrgScopedRow {
  id: string;
  org_id: string | null;
}

// Every row folded into one draft must belong to the org that draft is filed
// under. Returns the offenders rather than throwing: the caller decides whether
// to drop them and carry on, and either way the ids can be logged.
export function foreignOrgRows<T extends OrgScopedRow>(orgId: string | null | undefined, rows: T[]): T[] {
  const owner = orgId ?? null;
  return rows.filter((r) => (r.org_id ?? null) !== owner);
}

// The inbound half of the same invariant. When we cannot tell from the receiving
// mailbox which client an incoming supplier reply belongs to, the only safe way
// to attach it to an existing outreach is if every candidate row belongs to ONE
// client. Two clients' drafts on the same thread means the sender is ambiguous,
// and guessing files a supplier's reply (prices, terms, documents) under a
// company that never asked. Returns null so the caller sends it to triage, which
// is a human reading it a few hours later rather than a silent misattribution.
export function soleOrgOwner<T extends { org_id: string | null }>(rows: T[] | null | undefined): string | null {
  const owners = new Set((rows ?? []).map((r) => r.org_id ?? null));
  if (owners.size !== 1) return null;
  return [...owners][0];
}
