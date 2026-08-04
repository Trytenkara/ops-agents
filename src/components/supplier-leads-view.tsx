"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { SupplierProfileCard } from "@/components/supplier-profile-card";
import { createSupplierProfile } from "@/app/actions/supplier-profiles";
import { LeadRichRow, LeadRichHeaders, leadRichColSpan, LeadMatchBadge, LeadSourceBadge } from "@/components/lead-rich-row";
import { ListCsvButton } from "@/components/list-csv-button";
import { filenameFor } from "@/lib/csv";
import { profileCompleteness, type SupplierProfile } from "@/lib/supplier-profiles";
import { UnlinkedMarketplaceLogins, type MarketplaceAccount } from "@/components/marketplace-logins";
import { normalizeHost } from "@/lib/marketplace-accounts";
import { deriveMatchTier } from "@/lib/lead-match-tier";
import { leadMarketKind, MARKET_KIND_LABEL, MARKET_KIND_TITLE, MARKET_KIND_VARIANT, type MarketKind } from "@/lib/lead-market";
import { relativeTime } from "@/lib/utils";

interface SupplierGroup {
  supplierName: string;
  supplierId: string | null;
  profile: SupplierProfile | null;
  leads: any[];
  marketKind: MarketKind | null;
  latestLead: string | null;
  accounts: MarketplaceAccount[];
  marketplaceHost: string;
}

// Sites this supplier is known by, so an agent-provisioned login (keyed only by
// host) lands on the right validation card.
function hostsFor(group: SupplierGroup): string[] {
  const urls: string[] = [];
  for (const lead of group.leads) {
    const p = lead.payload ?? {};
    urls.push(p.supplier_website, p.source_url, p.marketplace_pull?.source_url, p.enrichment?.contact?.contact_url);
  }
  const fromNotes = group.profile?.generated_notes?.match(/https?:\/\/\S+/g) ?? [];
  urls.push(...fromNotes);
  const hosts = urls.filter(Boolean).map((u: string) => normalizeHost(u)).filter(Boolean);
  return Array.from(new Set(hosts));
}

// Fallback when no lead carried a URL: "scentedexpressions.com" ↔ "Scented
// Expressions". Long enough to be a real signal, not a two-letter collision.
function nameMatchesHost(supplierName: string, host: string): boolean {
  const slug = supplierName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const root = host.split(".")[0].replace(/[^a-z0-9]/g, "");
  if (slug.length < 6 || root.length < 6) return slug === root && slug.length > 0;
  return slug === root || slug.startsWith(root) || root.startsWith(slug);
}

const SORT_OPTIONS = [
  { value: "leads", label: "Most leads" },
  { value: "name", label: "Supplier (A-Z)" },
  { value: "completeness", label: "Profile completeness" },
  { value: "newest", label: "Newest leads" },
];

const STATUS_FILTER = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "pending_review", label: "Pending Review" },
  { value: "ready_for_submission", label: "Ready" },
  { value: "submitted", label: "Submitted" },
  { value: "no_profile", label: "No profile yet" },
];

export function SupplierLeadsView({
  rows,
  profiles,
  marketplaceAccounts = [],
  canAct,
  slug,
  orgId,
  operatorOptions,
}: {
  rows: any[];
  profiles: SupplierProfile[];
  marketplaceAccounts?: MarketplaceAccount[];
  canAct: boolean;
  slug: string;
  orgId: string;
  operatorOptions?: { id: string; name: string }[];
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("leads");
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedSupplier, setExpandedSupplier] = useState<string | null>(null);
  const [showLeadsFor, setShowLeadsFor] = useState<string | null>(null);
  const [showAddSupplier, setShowAddSupplier] = useState(false);

  const profileBySupplier = new Map<string, SupplierProfile>();
  const profileByName = new Map<string, SupplierProfile>();
  for (const p of profiles) {
    if (p.supplier_id) profileBySupplier.set(p.supplier_id, p);
    profileByName.set(p.supplier_name.toLowerCase(), p);
  }

  // Group leads by supplier
  const groupMap = new Map<string, SupplierGroup>();
  for (const lead of rows) {
    const key = lead.supplier_id ?? lead.supplier_name ?? "unknown";
    let group = groupMap.get(key);
    if (!group) {
      const profile = lead.supplier_id
        ? profileBySupplier.get(lead.supplier_id) ?? null
        : profileByName.get((lead.supplier_name ?? "").toLowerCase()) ?? null;
      const mk = (lead.market_kind as MarketKind | null) ?? leadMarketKind(lead.payload?.site_type);
      group = {
        supplierName: lead.supplier_name ?? "Unknown",
        supplierId: lead.supplier_id ?? null,
        profile,
        leads: [],
        marketKind: mk === "marketplace" || mk === "aggregator" || mk === "direct" ? mk : null,
        latestLead: null,
        accounts: [],
        marketplaceHost: "",
      };
      groupMap.set(key, group);
    }
    group.leads.push(lead);
    if (!group.latestLead || (lead.created_at && lead.created_at > group.latestLead)) {
      group.latestLead = lead.created_at;
    }
  }

  // Also add profiles that have no matching leads yet
  for (const p of profiles) {
    const key = p.supplier_id ?? p.supplier_name.toLowerCase();
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        supplierName: p.supplier_name,
        supplierId: p.supplier_id,
        profile: p,
        leads: [],
        marketKind: p.supplier_type,
        latestLead: null,
        accounts: [],
        marketplaceHost: "",
      });
    }
  }

  // Attach each login to its supplier: an explicit link first, then the host it
  // was created for. Whatever matches nothing surfaces as an exception rather
  // than disappearing.
  const allGroups = Array.from(groupMap.values());
  const hostIndex = allGroups.map((g) => ({ group: g, hosts: hostsFor(g) }));
  for (const entry of hostIndex) entry.group.marketplaceHost = entry.hosts[0] ?? "";
  const unlinkedAccounts: MarketplaceAccount[] = [];
  for (const a of marketplaceAccounts) {
    const owner =
      (a.supplier_profile_id && allGroups.find((g) => g.profile?.id === a.supplier_profile_id)) ||
      hostIndex.find((e) => e.hosts.includes(a.host))?.group ||
      allGroups.find((g) => nameMatchesHost(g.supplierName, a.host));
    if (owner) owner.accounts.push(a);
    else unlinkedAccounts.push(a);
  }

  let groups = allGroups;

  // Filters
  if (search) {
    const q = search.toLowerCase();
    groups = groups.filter((g) => {
      const hay = `${g.supplierName} ${g.profile?.poc_email ?? ""} ${g.profile?.poc_name ?? ""} ${g.leads.map((l: any) => l.material_name ?? "").join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }
  if (statusFilter !== "all") {
    if (statusFilter === "no_profile") {
      groups = groups.filter((g) => !g.profile);
    } else {
      groups = groups.filter((g) => g.profile?.approval_status === statusFilter);
    }
  }

  // Sort
  groups = [...groups].sort((a, b) => {
    switch (sort) {
      case "name":
        return a.supplierName.localeCompare(b.supplierName);
      case "completeness": {
        const aPct = a.profile ? profileCompleteness(a.profile).pct : -1;
        const bPct = b.profile ? profileCompleteness(b.profile).pct : -1;
        return bPct - aPct;
      }
      case "newest": {
        const aDate = a.latestLead ?? "";
        const bDate = b.latestLead ?? "";
        return bDate.localeCompare(aDate);
      }
      default:
        return b.leads.length - a.leads.length;
    }
  });

  const totalSuppliers = groupMap.size;
  const withProfile = Array.from(groupMap.values()).filter((g) => g.profile).length;
  const avgCompleteness = withProfile > 0
    ? Math.round(
        Array.from(groupMap.values())
          .filter((g) => g.profile)
          .reduce((sum, g) => sum + profileCompleteness(g.profile!).pct, 0) / withProfile
      )
    : 0;

  // CSV export: one row per supplier with profile completeness + lead counts
  const csvHeaders = [
    "Supplier", "Type", "Leads", "Profile Status", "Completeness %",
    "POC Email", "POC Phone", "POC Name",
    "Shipping Address", "Shipping Terms", "Shipping Email",
    "DDP Can Book", "DDP Min", "DDP Max",
    "Billing Email", "Billing POC",
    "Upfront %", "Net Days", "Payment Completion", "Credit Line",
    "Hazmat Fee", "Temp Storage Fee", "Liftgate Fee", "Special Packaging Fee",
    "Materials",
  ];
  const csvRows = groups.map((g) => {
    const p = g.profile;
    const materials = Array.from(new Set(g.leads.map((l: any) => l.material_name).filter(Boolean))).join("; ");
    return [
      g.supplierName,
      g.marketKind ?? "",
      g.leads.length,
      p?.approval_status ?? "no profile",
      p ? profileCompleteness(p).pct : "",
      p?.poc_email ?? "",
      p?.poc_phone ?? "",
      p?.poc_name ?? "",
      p?.shipping_address ?? "",
      p?.shipping_terms ?? "",
      p?.shipping_email ?? "",
      p?.ddp_can_book ? "Yes" : "No",
      p?.ddp_min_limit ?? "",
      p?.ddp_max_limit ?? "",
      p?.billing_email ?? "",
      p?.billing_poc_name ?? "",
      p?.payment_upfront_pct ?? "",
      p?.payment_net_days ?? "",
      p?.payment_completion ?? "",
      p?.payment_credit_line ?? "",
      p?.hazmat_handling_fee ?? 0,
      p?.temp_storage_fee ?? 0,
      p?.liftgate_fee ?? 0,
      p?.special_packaging_fee ?? 0,
      materials,
    ];
  });

  return (
    <div className="space-y-4">
      <UnlinkedMarketplaceLogins
        accounts={unlinkedAccounts}
        orgId={orgId}
        canAct={canAct}
        supplierOptions={allGroups
          .filter((g) => g.profile)
          .map((g) => ({ id: g.profile!.id, name: g.supplierName }))
          .sort((a, b) => a.name.localeCompare(b.name))}
      />
      {/* Summary bar */}
      <div className="flex items-center gap-4 text-sm flex-wrap">
        <span className="text-muted-foreground">
          {totalSuppliers} supplier{totalSuppliers !== 1 ? "s" : ""}
        </span>
        <span className="text-muted-foreground">
          {withProfile} with profile{withProfile !== totalSuppliers ? ` (${totalSuppliers - withProfile} need profiles)` : ""}
        </span>
        <span className="text-muted-foreground">Avg completeness: {avgCompleteness}%</span>
        {canAct && (
          <Button variant="outline" size="sm" onClick={() => setShowAddSupplier(true)}>
            Add supplier
          </Button>
        )}
      </div>

      {/* Add supplier form */}
      {showAddSupplier && canAct && (
        <AddSupplierForm orgId={orgId} onClose={() => setShowAddSupplier(false)} />
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Search</span>
          <Input
            type="text"
            placeholder="supplier, material, email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-56"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Profile status</span>
          <Select
            size="sm"
            className="min-w-[10rem]"
            ariaLabel="Status"
            value={statusFilter}
            onValueChange={setStatusFilter}
            options={STATUS_FILTER}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Sort</span>
          <Select
            size="sm"
            className="min-w-[10rem]"
            ariaLabel="Sort"
            value={sort}
            onValueChange={setSort}
            options={SORT_OPTIONS}
          />
        </label>
        <div className="ml-auto">
          <ListCsvButton
            filename={filenameFor(slug, "supplier-leads")}
            headers={csvHeaders}
            rows={csvRows}
          />
        </div>
      </div>

      {/* Supplier groups */}
      <div className="space-y-2">
        {groups.map((g) => {
          const key = g.supplierId ?? g.supplierName;
          const isExpanded = expandedSupplier === key;
          const isShowingLeads = showLeadsFor === key;
          const comp = g.profile ? profileCompleteness(g.profile) : null;
          const materials = Array.from(new Set(g.leads.map((l: any) => l.material_name).filter(Boolean)));
          const stages = { raw: 0, enriched: 0, ready_for_outreach: 0, held: 0 };
          for (const l of g.leads) {
            if (l.needs_material_name) stages.held++;
            else if (l.stage in stages) (stages as any)[l.stage]++;
          }

          return (
            <div key={key} className="rounded-lg border bg-card overflow-hidden">
              {/* Supplier summary row */}
              <div
                className="flex items-center justify-between px-4 py-3 hover:bg-accent/50 cursor-pointer transition-colors"
                onClick={() => setExpandedSupplier(isExpanded ? null : key)}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs text-muted-foreground">{isExpanded ? "v" : ">"}</span>
                  <span className="font-medium text-sm truncate">{g.supplierName}</span>
                  {g.marketKind && (
                    <Badge variant={MARKET_KIND_VARIANT[g.marketKind]} title={MARKET_KIND_TITLE[g.marketKind]}>
                      {MARKET_KIND_LABEL[g.marketKind]}
                    </Badge>
                  )}
                  {g.profile ? (
                    <Badge variant={
                      g.profile.approval_status === "ready_for_submission" || g.profile.approval_status === "submitted" ? "success" :
                      g.profile.approval_status === "pending_review" ? "warn" : "secondary"
                    }>
                      {g.profile.approval_status.replace(/_/g, " ")}
                    </Badge>
                  ) : (
                    <Badge variant="outline">No profile</Badge>
                  )}
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  {/* Stage dots */}
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    {stages.raw > 0 && <span title="Raw"><span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-400" /> {stages.raw}</span>}
                    {stages.enriched > 0 && <span title="Enriched"><span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500" /> {stages.enriched}</span>}
                    {stages.ready_for_outreach > 0 && <span title="Ready"><span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" /> {stages.ready_for_outreach}</span>}
                    {stages.held > 0 && <span title="Held"><span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" /> {stages.held}</span>}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {g.leads.length} lead{g.leads.length !== 1 ? "s" : ""}
                  </span>
                  {comp && (
                    <div className="flex items-center gap-2 w-20">
                      <div className="h-1.5 flex-1 bg-secondary rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${comp.pct >= 80 ? "bg-green-500" : comp.pct >= 50 ? "bg-yellow-500" : "bg-red-400"}`}
                          style={{ width: `${comp.pct}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground tabular-nums">{comp.pct}%</span>
                    </div>
                  )}
                  {materials.length > 0 && (
                    <span className="text-xs text-muted-foreground truncate max-w-[16ch]" title={materials.join(", ")}>
                      {materials[0]}{materials.length > 1 ? ` +${materials.length - 1}` : ""}
                    </span>
                  )}
                </div>
              </div>

              {/* Expanded: profile card + leads */}
              {isExpanded && (
                <div className="border-t px-4 py-4 space-y-4 bg-muted/20">
                  {/* Profile card */}
                  {g.profile ? (
                    <SupplierProfileCard
                      profile={g.profile}
                      orgId={orgId}
                      leadCount={g.leads.length}
                      canAct={canAct}
                      marketplaceAccounts={g.accounts}
                      marketplaceHost={g.marketplaceHost || g.accounts[0]?.host || ""}
                    />
                  ) : (
                    <div className="rounded-lg border border-dashed p-4 text-center">
                      <p className="text-sm text-muted-foreground">
                        Profile not built yet. Agent 06 creates it automatically on its next pass.
                      </p>
                    </div>
                  )}

                  {/* Leads for this supplier */}
                  {g.leads.length > 0 && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setShowLeadsFor(isShowingLeads ? null : key)}
                        className="text-xs text-muted-foreground hover:text-foreground mb-2"
                      >
                        {isShowingLeads ? "Hide" : "Show"} {g.leads.length} lead{g.leads.length !== 1 ? "s" : ""}
                      </button>
                      {isShowingLeads && (
                        <Table>
                          <TableHeader>
                            <LeadRichHeaders showOrg={false} selectable={false} />
                          </TableHeader>
                          <TableBody>
                            {g.leads.map((lead: any) => (
                              <LeadRichRow
                                key={lead.id}
                                r={lead}
                                canAct={canAct}
                                showOrg={false}
                                orgId={orgId}
                                operatorOptions={operatorOptions}
                              />
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {groups.length === 0 && (
          <p className="text-center text-muted-foreground py-8">No suppliers match your filters.</p>
        )}
      </div>
    </div>
  );
}

function AddSupplierForm({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const [supplierName, setSupplierName] = useState("");
  const [pocEmail, setPocEmail] = useState("");
  const [supplierType, setSupplierType] = useState<"marketplace" | "direct">("direct");
  const [creating, startCreate] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleCreate() {
    if (!supplierName.trim()) {
      setError("Supplier name is required");
      return;
    }
    startCreate(async () => {
      const res = await createSupplierProfile(orgId, null, supplierName.trim(), {
        supplier_type: supplierType,
        poc_email: pocEmail.trim() || null,
      });
      if (res.ok) onClose();
      else setError(res.error ?? "Failed to create");
    });
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <h4 className="text-sm font-semibold">Add new supplier</h4>
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 flex-1 min-w-[14rem]">
          <span className="text-xs text-muted-foreground">Supplier name</span>
          <Input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} className="h-8" placeholder="e.g. Acme Chemicals" />
        </label>
        <label className="flex flex-col gap-1 flex-1 min-w-[14rem]">
          <span className="text-xs text-muted-foreground">Email (optional)</span>
          <Input value={pocEmail} onChange={(e) => setPocEmail(e.target.value)} className="h-8" placeholder="contact@example.com" type="email" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Type</span>
          <Select
            size="sm"
            className="w-40"
            ariaLabel="Supplier type"
            value={supplierType}
            onValueChange={(v) => setSupplierType(v as "marketplace" | "direct")}
            options={[
              { value: "direct", label: "Direct" },
              { value: "marketplace", label: "Marketplace" },
            ]}
          />
        </label>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={handleCreate} disabled={creating}>
          {creating ? "Creating..." : "Create"}
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}
