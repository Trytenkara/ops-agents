"use client";

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SupplierProfileCard } from "@/components/supplier-profile-card";
import { seedSupplierProfiles } from "@/app/actions/supplier-profiles";
import type { SupplierProfile } from "@/lib/supplier-profiles";
import { profileCompleteness } from "@/lib/supplier-profiles";

interface SupplierRow {
  profile: SupplierProfile;
  leadCount: number;
  tenkara: { approval: string; qualified: boolean } | null;
}

const STATUS_FILTER = [
  { value: "all", label: "All statuses" },
  { value: "draft", label: "Draft" },
  { value: "pending_review", label: "Pending Review" },
  { value: "ready_for_submission", label: "Ready" },
  { value: "submitted", label: "Submitted" },
];

const SORT_OPTIONS = [
  { value: "name", label: "Name (A-Z)" },
  { value: "completeness", label: "Completeness" },
  { value: "leads", label: "Lead count" },
  { value: "updated", label: "Recently updated" },
];

export function SupplierProfilesList({
  suppliers,
  orgId,
  canAct,
}: {
  suppliers: SupplierRow[];
  orgId: string;
  canAct: boolean;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("name");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [seeding, startSeed] = useTransition();
  const [seedResult, setSeedResult] = useState<string | null>(null);

  let filtered = suppliers.filter((s) => {
    if (statusFilter !== "all" && s.profile.approval_status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = `${s.profile.supplier_name} ${s.profile.poc_email ?? ""} ${s.profile.poc_name ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  filtered = [...filtered].sort((a, b) => {
    switch (sort) {
      case "completeness":
        return profileCompleteness(b.profile).pct - profileCompleteness(a.profile).pct;
      case "leads":
        return b.leadCount - a.leadCount;
      case "updated":
        return b.profile.updated_at.localeCompare(a.profile.updated_at);
      default:
        return a.profile.supplier_name.localeCompare(b.profile.supplier_name);
    }
  });

  const totalLeads = suppliers.reduce((sum, s) => sum + s.leadCount, 0);
  const avgCompleteness = suppliers.length
    ? Math.round(suppliers.reduce((sum, s) => sum + profileCompleteness(s.profile).pct, 0) / suppliers.length)
    : 0;

  function handleSeed() {
    startSeed(async () => {
      const res = await seedSupplierProfiles(orgId);
      if (res.ok) {
        setSeedResult(`Seeded ${res.count ?? 0} new profiles from leads`);
        setTimeout(() => setSeedResult(null), 3000);
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* Summary stats */}
      <div className="flex items-center gap-4 text-sm">
        <span className="text-muted-foreground">
          {suppliers.length} supplier{suppliers.length !== 1 ? "s" : ""}
        </span>
        <span className="text-muted-foreground">{totalLeads} leads</span>
        <span className="text-muted-foreground">Avg completeness: {avgCompleteness}%</span>
        {canAct && (
          <Button variant="outline" size="sm" onClick={handleSeed} disabled={seeding}>
            {seeding ? "Seeding..." : "Seed from leads"}
          </Button>
        )}
        {seedResult && <span className="text-xs text-green-600">{seedResult}</span>}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Search</span>
          <Input
            type="text"
            placeholder="supplier, email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-48"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Status</span>
          <Select
            size="sm"
            className="min-w-[9rem]"
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
            className="min-w-[9rem]"
            ariaLabel="Sort"
            value={sort}
            onValueChange={setSort}
            options={SORT_OPTIONS}
          />
        </label>
      </div>

      {/* Supplier cards */}
      <div className="space-y-3">
        {filtered.map((s) => {
          const isExpanded = expandedId === s.profile.id;
          const comp = profileCompleteness(s.profile);
          if (!isExpanded) {
            return (
              <div
                key={s.profile.id}
                className="flex items-center justify-between rounded-lg border bg-card px-4 py-3 hover:bg-accent/50 cursor-pointer transition-colors"
                onClick={() => setExpandedId(s.profile.id)}
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium text-sm">{s.profile.supplier_name}</span>
                  {s.profile.supplier_type && (
                    <Badge variant="secondary">{s.profile.supplier_type}</Badge>
                  )}
                  <Badge variant={
                    s.profile.approval_status === "ready_for_submission" ? "success" :
                    s.profile.approval_status === "pending_review" ? "warn" : "secondary"
                  }>
                    {s.profile.approval_status.replace(/_/g, " ")}
                  </Badge>
                  {s.tenkara && (
                    <Badge variant={s.tenkara.approval === "approved" ? "success" : "secondary"}>
                      Platform: {s.tenkara.approval}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-muted-foreground">{s.leadCount} leads</span>
                  <div className="flex items-center gap-2 w-24">
                    <div className="h-1.5 flex-1 bg-secondary rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${comp.pct >= 80 ? "bg-green-500" : comp.pct >= 50 ? "bg-yellow-500" : "bg-red-400"}`}
                        style={{ width: `${comp.pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">{comp.pct}%</span>
                  </div>
                  <span className="text-xs text-muted-foreground">{s.profile.poc_email ?? "no email"}</span>
                </div>
              </div>
            );
          }
          return (
            <div key={s.profile.id} className="space-y-1">
              <button
                className="text-xs text-muted-foreground hover:text-foreground transition-colors px-1"
                onClick={() => setExpandedId(null)}
              >
                Collapse
              </button>
              <SupplierProfileCard
                profile={s.profile}
                orgId={orgId}
                leadCount={s.leadCount}
                canAct={canAct}
                tenkara={s.tenkara}
              />
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-center text-muted-foreground py-8">No suppliers match your filters.</p>
        )}
      </div>
    </div>
  );
}
