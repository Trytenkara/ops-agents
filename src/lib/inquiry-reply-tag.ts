// Plus-tag reply routing for aggregator inquiry forms.
//
// A seller split out of a marketplace index page publishes no email: the only
// way to reach it is the platform's own "Send Inquiry" form, which takes a
// reply address as free text. That reply arrives from an address we have never
// seen, in a thread we never created, with no draft to match on, so every
// existing matcher in tenkara-inbound misses it and the reply dead-letters.
//
// So we hand the form a tagged address (info+q7k2m4pd@client.com). The tag is
// minted per inquiry and recorded on the draft_references row standing in for
// that submission, which makes an inbound tag an ordinary, and in fact the
// strongest, way to identify the originating outreach.
//
// Mailbox support is not universal: Google Workspace passes +tags through, and
// Microsoft 365 needs subaddressing enabled on the tenant, so check the client's
// provider before relying on this for them.

import { randomBytes } from "crypto";

// No l/1/o/0: these tags get retyped by hand off a web form often enough that
// the ambiguous glyphs are a real source of misrouted replies.
const TAG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const TAG_BODY_LENGTH = 8;
// Namespaces the tag so an operator (or a matcher) can tell our routing tag from
// a plus-tag a human typed for their own filing.
const TAG_PREFIX = "q";

const TAG_PATTERN = new RegExp(`^${TAG_PREFIX}[${TAG_ALPHABET}]{${TAG_BODY_LENGTH}}$`);

export function mintInquiryReplyTag(): string {
  const bytes = randomBytes(TAG_BODY_LENGTH);
  let body = "";
  for (const byte of bytes) body += TAG_ALPHABET[byte % TAG_ALPHABET.length];
  return TAG_PREFIX + body;
}

export function isInquiryReplyTag(tag: string | null): boolean {
  return !!tag && TAG_PATTERN.test(tag);
}

// "info+q7k2m4pd@client.com" → { base: "info@client.com", tag: "q7k2m4pd" }.
// Only OUR tag shape is extracted; any other plus-part is left on the base
// address so an inbox that genuinely contains a "+" still resolves.
export function parseTaggedRecipient(address: string | null | undefined): { base: string | null; tag: string | null } {
  const addr = address?.trim().toLowerCase() || null;
  if (!addr || !addr.includes("@")) return { base: addr, tag: null };
  const at = addr.lastIndexOf("@");
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus < 0) return { base: addr, tag: null };
  const tag = local.slice(plus + 1);
  if (!isInquiryReplyTag(tag)) return { base: addr, tag: null };
  return { base: `${local.slice(0, plus)}@${domain}`, tag };
}

export function taggedAddress(inbox: string, tag: string): string {
  const at = inbox.lastIndexOf("@");
  return `${inbox.slice(0, at)}+${tag}@${inbox.slice(at + 1)}`;
}
