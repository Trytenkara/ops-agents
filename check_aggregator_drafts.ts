import { createAdminClient } from "./src/lib/supabase/admin";

async function main() {
  const admin = createAdminClient();

  // Aggregator leads with manual contact source
  console.log("\n=== Aggregator suppliers with manually-added emails ===\n");
  const { data: manualAggregators } = await admin
    .from("leads_in_flight")
    .select("id, supplier_name, material_name, stage, status, payload->site_type, payload->contact_source, payload->supplier_contact_email, created_at")
    .eq("status", "active")
    .eq("payload->site_type", "A")
    .eq("payload->contact_source", "manual_operator")
    .order("created_at", { ascending: false })
    .limit(10);

  if (manualAggregators?.length) {
    console.log(`Found ${manualAggregators.length} aggregator leads with manual contacts:\n`);
    for (const l of manualAggregators) {
      console.log(`  ${l.supplier_name} / ${l.material_name}`);
      console.log(`    Stage: ${l.stage}`);
      console.log(`    Email: ${l.supplier_contact_email}`);
      console.log(`    Created: ${l.created_at}`);
    }
  } else {
    console.log("No aggregator leads with manual contacts found (yet)");
  }

  // Check for drafts created for these suppliers
  console.log("\n=== Drafts created recently for aggregator suppliers ===\n");
  const { data: recentDrafts } = await admin
    .from("draft_references")
    .select("id, lead_id, draft_kind, metadata, created_at")
    .eq("draft_kind", "cold_outreach")
    .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(20);

  if (recentDrafts?.length) {
    console.log(`Found ${recentDrafts.length} recent cold outreach drafts\n`);
    for (const d of recentDrafts) {
      console.log(`  Draft: ${d.id?.slice(0, 8)}...`);
      console.log(`    Lead ID: ${d.lead_id?.slice(0, 8)}...`);
      console.log(`    Created: ${d.created_at}`);
    }
  } else {
    console.log("No recent outreach drafts found");
  }

  // Check stage distribution for aggregators
  console.log("\n=== Stage distribution for aggregator leads (site_type=A) ===\n");
  const { data: stageStats } = await admin
    .from("leads_in_flight")
    .select("stage, status")
    .eq("payload->site_type", "A")
    .eq("status", "active");

  const stageCounts = new Map<string, number>();
  for (const row of stageStats ?? []) {
    stageCounts.set(row.stage, (stageCounts.get(row.stage) ?? 0) + 1);
  }

  for (const [stage, count] of Array.from(stageCounts.entries()).sort()) {
    console.log(`  ${stage}: ${count}`);
  }
}

main().catch(console.error);
