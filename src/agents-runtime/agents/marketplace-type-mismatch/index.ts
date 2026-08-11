import { registerAgent } from "../../registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { postSlackMessage } from "@/lib/slack";
import { shouldPostDigest, recordDigestPosted } from "@/lib/alert-policy";
import { isAggregatorHost } from "@/lib/aggregator-hosts";

type Admin = ReturnType<typeof createAdminClient>;

// Agent 21 — Marketplace Type Mismatch Watchdog.
//
// Tracks leads where the `source` field claims "marketplace" but the supplier's
// actual website is a direct domain, or vice versa. This catches misclassifications
// that could route leads down the wrong outreach path.
//
// Read-only: this agent never mutates sourcing data.

interface Mismatch {
  lead_id: string;
  supplier_name: string;
  material_name: string;
  source: string;
  detected_type: string;
  supplier_website: string | null;
  mismatch_type: "claimed_marketplace_is_direct" | "claimed_direct_is_marketplace";
}

async function findMismatches(admin: Admin): Promise<Mismatch[]> {
  const { data, error } = await admin
    .from("leads_in_flight")
    .select("id, supplier_name, material_name, source, payload")
    .eq("status", "active");

  if (error) throw new Error(`Query failed: ${error.message}`);

  const mismatches: Mismatch[] = [];
  const leads = (data ?? []) as any[];

  for (const lead of leads) {
    const payload = (lead.payload ?? {}) as Record<string, any>;
    // Source field says whether this lead came from a marketplace
    const sourceClaimsMarketplace = lead.source === "marketplace" || lead.source === "aggregator";
    const supplierWebsite = (payload.supplier_website ?? payload.marketplace_pull?.source_url ?? "") as string;

    if (!supplierWebsite) continue; // Can't detect without a website

    const host = extractHost(supplierWebsite);
    if (!host) continue;

    // Determine actual detected type from the website domain
    const isAggregator = isAggregatorHost(host);
    const detectedAsMarketplace = isAggregator || payload.enrichment?.tenkara_supplier?.is_marketplace === true;

    // Check for mismatch: what source says vs what the domain tells us
    if (sourceClaimsMarketplace && !detectedAsMarketplace) {
      // Source says marketplace but domain is direct
      mismatches.push({
        lead_id: lead.id,
        supplier_name: lead.supplier_name ?? "Unknown",
        material_name: lead.material_name ?? "Unknown",
        source: lead.source,
        detected_type: "direct",
        supplier_website: supplierWebsite,
        mismatch_type: "claimed_marketplace_is_direct",
      });
    } else if (!sourceClaimsMarketplace && detectedAsMarketplace) {
      // Source says direct but domain is marketplace/aggregator
      mismatches.push({
        lead_id: lead.id,
        supplier_name: lead.supplier_name ?? "Unknown",
        material_name: lead.material_name ?? "Unknown",
        source: lead.source,
        detected_type: isAggregator ? "aggregator" : "marketplace",
        supplier_website: supplierWebsite,
        mismatch_type: "claimed_direct_is_marketplace",
      });
    }
  }

  return mismatches;
}

function extractHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    const extracted = url.replace(/^https?:\/\//, "").split("/")[0].toLowerCase().replace(/^www\./, "");
    return extracted || null;
  }
}

function renderMismatches(mismatches: Mismatch[]): string {
  if (mismatches.length === 0) {
    return "🟢 No marketplace/direct mismatches detected";
  }

  const claimed_mp_is_direct = mismatches.filter((m) => m.mismatch_type === "claimed_marketplace_is_direct");
  const claimed_direct_is_mp = mismatches.filter((m) => m.mismatch_type === "claimed_direct_is_marketplace");

  const lines: string[] = [];
  lines.push(`Marketplace classification drift — ${mismatches.length} lead(s)`);

  if (claimed_mp_is_direct.length > 0) {
    lines.push(`🔴 Claimed marketplace but is direct (${claimed_mp_is_direct.length}):`);
    for (const m of claimed_mp_is_direct.slice(0, 10)) {
      lines.push(
        `  • ${m.supplier_name} / ${m.material_name} (source='${m.source}', host=${extractHost(m.supplier_website || "") || "unknown"})`
      );
    }
    if (claimed_mp_is_direct.length > 10) {
      lines.push(`  ... and ${claimed_mp_is_direct.length - 10} more`);
    }
  }

  if (claimed_direct_is_mp.length > 0) {
    lines.push(`🟡 Claimed direct but is marketplace (${claimed_direct_is_mp.length}):`);
    for (const m of claimed_direct_is_mp.slice(0, 10)) {
      lines.push(
        `  • ${m.supplier_name} / ${m.material_name} (source='${m.source}', detected as ${m.detected_type})`
      );
    }
    if (claimed_direct_is_mp.length > 10) {
      lines.push(`  ... and ${claimed_direct_is_mp.length - 10} more`);
    }
  }

  return lines.join("\n");
}

function mismatchFingerprint(mismatches: Mismatch[]): string {
  const claimed_mp = mismatches.filter((m) => m.mismatch_type === "claimed_marketplace_is_direct").length;
  const claimed_direct = mismatches.filter((m) => m.mismatch_type === "claimed_direct_is_marketplace").length;
  return `mp_direct=${claimed_mp} direct_mp=${claimed_direct}`;
}

registerAgent({
  slug: "agent-21-marketplace-mismatch",
  displayName: "Agent 21 - Marketplace Type Mismatch Watchdog",
  description:
    "Tracks leads where source claims marketplace but the website is direct, or vice versa. Catches routing misclassifications. Posted as part of daily sourcing health digest.",
  async run(ctx) {
    const admin = createAdminClient();

    let mismatches: Mismatch[] = [];
    try {
      mismatches = await findMismatches(admin);
    } catch (e: any) {
      await ctx.log(`Mismatch check failed: ${e?.message ?? e}`, { level: "error", step: "scan" });
      ctx.setStatus("failure");
      ctx.setSummary("Failed to scan for mismatches");
      return;
    }

    const fingerprint = mismatchFingerprint(mismatches);
    const rendered = renderMismatches(mismatches);

    ctx.setItemsProcessed(mismatches.length);
    ctx.setStatus("success");
    ctx.setSummary(`${mismatches.length} mismatches found`);

    await ctx.log(`Scanned for marketplace/direct mismatches: ${mismatches.length} found`, {
      step: "scan",
      data: { count: mismatches.length },
    });

    if (mismatches.length === 0) {
      await ctx.log("No mismatches — no Slack post", { step: "slack" });
      return;
    }

    if (!(await shouldPostDigest("marketplace_mismatch", fingerprint))) {
      await ctx.log("Mismatch report identical to last post; staying quiet", { step: "slack" });
      return;
    }

    const res = await postSlackMessage({
      channel: process.env.SOURCING_HEALTH_SLACK_CHANNEL,
      text: `*Marketplace classification drift*\n\`\`\`${rendered}\`\`\``,
    });

    if (!res.ok) {
      await ctx.log(`Slack digest not sent: ${res.error}`, { level: "warn", step: "slack" });
    } else {
      await recordDigestPosted("marketplace_mismatch", fingerprint);
      await ctx.log("Posted marketplace mismatch digest to Slack", { step: "slack" });
    }
  },
});
