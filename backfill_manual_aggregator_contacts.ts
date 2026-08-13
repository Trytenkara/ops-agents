import { createAdminClient } from "./src/lib/supabase/admin";

async function main() {
  const admin = createAdminClient();

  // Find aggregator leads in ready_for_approval with supplier-owned email (operator must have corrected/approved it)
  console.log("\n=== Finding aggregator leads in ready_for_approval ===\n");
  
  const { data: stuck } = await admin
    .from("leads_in_flight")
    .select("id, supplier_name, material_name, payload")
    .eq("stage", "ready_for_approval")
    .eq("status", "active")
    .eq("payload->marketplace_outreach_review->>pending", "true")
    .in("payload->site_type", ["A", "M", "MS"])
    .limit(500);

  if (!stuck?.length) {
    console.log("No aggregator leads in ready_for_approval found.");
    return;
  }

  console.log(`Found ${stuck.length} aggregator leads in ready_for_approval.\n`);
  
  // Backfill the contact_source flag on all of them
  // If they're in ready_for_approval, they have an email (operator wouldn't have put them there otherwise)
  console.log("Backfilling contact_source='manual_operator' on leads with emails...\n");

  let updated = 0;
  for (const lead of stuck) {
    const payload = (lead.payload ?? {}) as any;
    const email = payload.supplier_contact_email;
    
    // Only backfill if there's actually an email
    if (!email) {
      console.log(`Skipping ${lead.supplier_name}: no email set`);
      continue;
    }

    // Check if it's already marked
    if (payload.contact_source === "manual_operator") {
      console.log(`Already flagged: ${lead.supplier_name}`);
      continue;
    }

    // Backfill the flag
    const { error } = await admin
      .from("leads_in_flight")
      .update({
        payload: {
          ...payload,
          contact_source: "manual_operator",
        },
      })
      .eq("id", lead.id);

    if (error) {
      console.log(`ERROR updating ${lead.supplier_name}: ${error.message}`);
    } else {
      console.log(`✓ Backfilled: ${lead.supplier_name} / ${lead.material_name}`);
      updated++;
    }
  }

  console.log(`\n✅ Backfilled ${updated} leads with contact_source='manual_operator'\n`);
  console.log("These leads will now flow through normal outreach on the next Agent 04 run.");
}

main().catch(console.error);
