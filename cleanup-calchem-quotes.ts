/**
 * CalChem Quote Data Cleanup
 * - Delete $999,999 extreme outliers
 * - Backfill densities for volume-based quotes
 * - Flag TOO_CHEAP quotes for operator review
 */

import { createAdminClient } from "@/lib/supabase/admin";

async function cleanupCalchemQuotes() {
  const admin = createAdminClient();
  
  console.log("Starting CalChem quote cleanup...\n");

  // 1. DELETE $999,999 entries
  console.log("1. Deleting extreme outliers ($999,999)...");
  const deleteIds = [
    "bdd35c7f-f3d5-4946-9938-c5aea0ff8c8d",
    "5e992bc0-c088-4cfd-923a-4f1237e51f6b",
  ];

  const { error: deleteError } = await admin
    .from("material_quotes")
    .delete()
    .in("id", deleteIds);

  if (deleteError) {
    console.error("  ❌ Delete failed:", deleteError);
  } else {
    console.log(`  ✅ Deleted ${deleteIds.length} entries`);
  }

  // 2. BACKFILL densities for MCT volume quotes
  console.log("\n2. Backfilling MCT densities (0.93 kg/L)...");
  
  // First get MCT material IDs
  const { data: mctMaterials, error: mctError } = await admin
    .from("materials")
    .select("id")
    .ilike("name", "%medium chain%triglyceride%");

  if (mctError) {
    console.error("  ❌ MCT material lookup failed:", mctError);
  } else if (!mctMaterials || mctMaterials.length === 0) {
    console.warn("  ⚠️ No MCT materials found");
  } else {
    const mctIds = mctMaterials.map((m) => m.id);
    
    const { error: mctUpdateError, count } = await admin
      .from("material_quotes")
      .update({
        density: 0.93,
        density_unit: "kg/L",
      })
      .in("material_id", mctIds)
      .in("unit_of_measurement", ["l", "ml", "gal_us", "fl_oz"])
      .is("density", null);

    if (mctUpdateError) {
      console.error("  ❌ MCT backfill failed:", mctUpdateError);
    } else {
      console.log(`  ✅ Backfilled ${count || 0} MCT volume quotes`);
    }
  }

  // 3. BACKFILL densities for MEA volume quotes
  console.log("\n3. Backfilling MEA densities (1.018 kg/L)...");

  const { data: meaMaterials, error: meaError } = await admin
    .from("materials")
    .select("id")
    .ilike("name", "%monoethanolamine%");

  if (meaError) {
    console.error("  ❌ MEA material lookup failed:", meaError);
  } else if (!meaMaterials || meaMaterials.length === 0) {
    console.warn("  ⚠️ No MEA materials found");
  } else {
    const meaIds = meaMaterials.map((m) => m.id);

    const { error: meaUpdateError, count } = await admin
      .from("material_quotes")
      .update({
        density: 1.018,
        density_unit: "kg/L",
      })
      .in("material_id", meaIds)
      .in("unit_of_measurement", ["l", "ml", "gal_us", "fl_oz"])
      .is("density", null);

    if (meaUpdateError) {
      console.error("  ❌ MEA backfill failed:", meaUpdateError);
    } else {
      console.log(`  ✅ Backfilled ${count || 0} MEA volume quotes`);
    }
  }

  // 4. Flag TOO_CHEAP quotes for operator review
  console.log("\n4. Flagging TOO_CHEAP quotes for review...");
  const tooCheapIds = [
    "5ec3d620-c441-4c4f-90a6-f0246d94f599", // Ji'an Zhongxiang $3/26kg MCT
    "e7f74256-92ed-4488-96bc-2d51c45a2b57", // Ji'an Zhongxiang $6/30kg MCT
    "a55bcdb2-fd35-4a4a-9df2-25675a315e3e", // Hangzhou Ontology $5.65/190kg MCT
    "671cdef6-ecc7-4fc1-8f8f-14ec664f33e1", // Shandong Baovi $0.4/1kg MEA
    "6b5ad3dd-341a-49b3-873a-deedbc1e432f", // R K Trading $0.52/1kg MEA
    "b6708f43-4ad9-4d1e-b72f-0cb057b9d02d", // Mehta Chemicals $1.51/200kg MEA
  ];

  const { error: flagError } = await admin
    .from("material_quotes")
    .update({
      notes: "⚠️ REVIEW: Price/case_size mismatch detected - verify per-unit vs per-case",
    })
    .in("id", tooCheapIds);

  if (flagError) {
    console.error("  ❌ Flag update failed:", flagError);
  } else {
    console.log(`  ✅ Flagged ${tooCheapIds.length} quotes for operator review`);
  }

  console.log("\n✅ Cleanup complete!");
  console.log("\nNext steps:");
  console.log("  1. Verify Control Room price-index shows corrected quotes");
  console.log("  2. Have operator verify the 6 flagged TOO_CHEAP quotes");
  console.log("  3. Implement validation gates to prevent future bad quotes");
}

// Run if executed directly
if (import.meta.main) {
  cleanupCalchemQuotes().catch(console.error);
}

export { cleanupCalchemQuotes };
