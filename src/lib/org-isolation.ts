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

export interface ReplyTargetRow {
  org_id: string | null;
  supplier_id: string | null;
  material_id: string | null;
}

/**
 * Which supplier and material do these candidate rows point at, if they agree?
 *
 * Use ONLY where the conversation itself establishes who is talking — a thread
 * id or a draft id. Rows grouped by something weaker (a sender's domain) can
 * hold two genuinely different counterparties, and the null tolerance below
 * would merge them; those callers stay strict.
 *
 * A NULL IS UNKNOWN, NOT A DISTINCT TARGET. Two rows conflict only when they
 * name different non-null values. Keying on `supplier_id ?? ""` instead treats
 * "we have not linked this supplier yet" as a second supplier, and half of all
 * cold outreach is written before the link exists (1,935 of 3,890 rows on
 * 2026-08-20): the cold_outbound row says `null:material`, the follow-up on the
 * same thread says `supplier:material`, the set has two members, and the reply
 * is refused as ambiguous. Every one of the 43 conversations that missed in the
 * 30 days to 2026-08-20 failed exactly here — including six California
 * Chemicals suppliers whose prices simply never arrived. The triage draft that
 * refusal then stages carries two nulls of its own, so under the old test the
 * thread could never match again.
 *
 * Returns null when the rows disagree, so the caller triages rather than
 * guessing. Returns the row to file against with the agreed ids overlaid, since
 * the row carrying the freshest context is not always the one that names them.
 */
export function soleReplyTarget<T extends ReplyTargetRow>(
  rows: T[] | null | undefined
): { ref: T; supplierId: string; materialId: string } | null {
  const candidates = rows ?? [];
  if (!candidates.length) return null;
  if (soleOrgOwner(candidates) === null) return null;

  const suppliers = new Set(candidates.map((r) => r.supplier_id).filter(Boolean) as string[]);
  const materials = new Set(candidates.map((r) => r.material_id).filter(Boolean) as string[]);
  if (suppliers.size !== 1 || materials.size !== 1) return null;

  const supplierId = [...suppliers][0];
  const materialId = [...materials][0];
  // Callers order most-recent-first. Prefer a row that names both ids, because
  // its metadata (contact address, subject, operator) describes the outreach
  // rather than a triage artefact.
  const ref =
    candidates.find((r) => r.supplier_id && r.material_id) ??
    candidates.find((r) => r.supplier_id || r.material_id) ??
    candidates[0];
  return { ref, supplierId, materialId };
}
