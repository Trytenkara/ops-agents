// One-off: addresses that already bounced were marked only on the draft, never
// on the lead, so the dead address stayed the lead's contact and outreach picked
// it straight back up. tenkara-inbound now retires at bounce time; this repairs
// the leads that predate that. Historic rows do not record whether the bounce
// was permanent, so anything that looks temporary is left alone.
import { createAdminClient } from "../src/lib/supabase/admin";
import { retireInPayload, isRetiredContact } from "../src/lib/contact-change";

const APPLY = process.argv.includes("--apply");
const a = createAdminClient();

const refs: any[] = [];
for (let from = 0; ; from += 1000) {
  const { data } = await a.from("draft_references")
    .select("id, metadata").eq("metadata->>flow_status", "bounced")
    .order("id", { ascending: true }).range(from, from + 999);
  const page = (data ?? []) as any[];
  refs.push(...page);
  if (page.length < 1000) break;
}

const TRANSIENT = /(mailbox|inbox|quota).{0,20}(full|exceeded)|over quota|temporar|try again later|delayed|greylist/i;
const addresses = new Set<string>();
let skippedTransient = 0;
for (const r of refs) {
  const e = String(r.metadata?.supplier_contact_email ?? "").trim().toLowerCase();
  if (!e) continue;
  if (r.metadata?.bounced?.permanent === false) { skippedTransient++; continue; }
  if (TRANSIENT.test(String(r.metadata?.bounced?.reason ?? ""))) { skippedTransient++; continue; }
  addresses.add(e);
}
console.log(`${refs.length} bounced drafts, ${addresses.size} distinct dead addresses, ${skippedTransient} skipped as temporary`);

let touched = 0, already = 0;
for (const email of addresses) {
  const { data: leads } = await a.from("leads_in_flight")
    .select("id, payload").eq("status", "active")
    .eq("payload->>supplier_contact_email", email).limit(500);
  for (const l of (leads ?? []) as any[]) {
    if (isRetiredContact(l.payload ?? {}, email)) { already++; continue; }
    touched++;
    if (APPLY) {
      await a.from("leads_in_flight")
        .update({ payload: retireInPayload(l.payload ?? {}, email, "bounced") })
        .eq("id", l.id);
    }
  }
}
console.log(APPLY ? "retired" : "would retire", touched, "leads;", already, "already retired");
