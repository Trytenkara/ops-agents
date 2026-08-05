// Narrowing an org's assignment_supplier_types used to drop the suppliers of the
// removed kinds out of the auto loop with nothing pinned in their place, so their
// owner (which was only ever derived) vanished and every validation page showed
// "Unassigned". Sierra lost 231 aggregators that way on 2026-08-05, California
// Chemicals the same an hour later.
//
// setOrgAssignmentSettings now pins the dropped kinds before the change lands.
// This repairs the two orgs where it already happened, by replaying the freeze
// against the config that was in force BEFORE the narrowing. Neither org's
// operator pool changed after its narrowing, so the replay reproduces exactly the
// owners the pages were showing.
//
// Run:
//   npx tsx -r dotenv/config scripts/repair-narrowed-assignment-scope.mts [--dry-run]
import { createAdminClient } from "@/lib/supabase/admin";
import { freezeDerivedOwners } from "@/lib/freeze-assignments";
import { ALL_SUPPLIER_TYPES, getOrgAssignmentContext, type AssignmentMode } from "@/lib/operator-assignment";
import type { MarketKind } from "@/lib/lead-market";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const admin = createAdminClient();
  const { data: orgs } = await admin.from("orgs").select("id, slug, assignment_mode, assignment_supplier_types");

  for (const org of orgs ?? []) {
    const types = (org.assignment_supplier_types ?? ALL_SUPPLIER_TYPES) as MarketKind[];
    const dropped = ALL_SUPPLIER_TYPES.filter((t) => !types.includes(t));
    if (dropped.length === 0) continue;

    // The narrowing event that dropped them, so we replay the exact prior config.
    const { data: events } = await admin
      .from("audit_log")
      .select("at, actor_user_id, diff")
      .eq("action", "org.assignment_settings_set")
      .eq("target_id", org.id)
      .order("at", { ascending: false })
      .limit(20);
    const narrowing = (events ?? []).find((e: any) => {
      const from = (e.diff?.from?.assignment_supplier_types ?? ALL_SUPPLIER_TYPES) as MarketKind[];
      const to = (e.diff?.to?.assignment_supplier_types ?? ALL_SUPPLIER_TYPES) as MarketKind[];
      return from.some((t) => !to.includes(t));
    }) as any;
    if (!narrowing) {
      console.log(`${org.slug}: narrowed to [${types}] but no narrowing event found, skipping`);
      continue;
    }

    const priorConfig = {
      mode: (narrowing.diff.from?.assignment_mode ?? "auto_new") as AssignmentMode,
      supplierTypes: (narrowing.diff.from?.assignment_supplier_types ?? ALL_SUPPLIER_TYPES) as MarketKind[],
    };
    const { count: claimed } = await admin
      .from("supplier_assignment")
      .select("supplier_id", { count: "exact", head: true })
      .eq("org_id", org.id);

    console.log(
      `${org.slug}: narrowed ${narrowing.at} to [${types}], restoring [${dropped}] ` +
        `from ${priorConfig.mode}/[${priorConfig.supplierTypes}] (${claimed ?? 0} existing claims)`
    );
    if (dryRun) {
      const ctx = await getOrgAssignmentContext(admin, org.id);
      console.log(`  auto pool: ${ctx.autoPool.map((p) => p.name).join(", ") || "(empty)"}`);
      continue;
    }
    const frozen = await freezeDerivedOwners(admin, org.id, narrowing.actor_user_id, dropped, priorConfig);
    console.log(`  pinned ${frozen}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
