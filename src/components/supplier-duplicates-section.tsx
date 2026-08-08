"use client";

import { useMemo, useState, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DupeGroup, DupeMember } from "@/lib/supplier-dupes";
import {
  confirmSupplierDupe,
  dismissSupplierDupe,
  reopenSupplierDupe,
  markSupplierDupeResolved,
} from "@/app/actions/supplier-dupes";

// Review surface for suspected duplicate suppliers, on the org's own Suppliers
// tab. Suggestions only: this app cannot write to Tenkara, so confirming a
// group shortlists it for an operator to merge there by hand.

export interface ConfirmedGroup {
  supplierIds: string[];
  names: Record<string, string>;
  survivorId: string | null;
  resolvedAt: string | null;
}

const RULE_LABEL: Record<DupeGroup["rule"], string> = {
  identical_website: "Same website",
  same_domain: "Same website domain",
};

function ApprovalBadge({ a }: { a: DupeMember["approval"] }) {
  const meta = {
    approved: { label: "Approved", variant: "success" as const },
    pending_review: { label: "Pending", variant: "warn" as const },
    denied: { label: "Denied", variant: "danger" as const },
    draft: { label: "Draft", variant: "secondary" as const },
  }[a] ?? { label: a, variant: "secondary" as const };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

function GroupCard({
  group,
  orgId,
  slug,
  canAct,
}: {
  group: DupeGroup;
  orgId: string;
  slug: string;
  canAct: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(group.members.map((m) => m.id)));
  // Default to the most-decided row: an approved supplier is the one a human
  // already vetted, so it is the safer thing to keep.
  const [survivor, setSurvivor] = useState<string>(() => {
    const approved = group.members.find((m) => m.approval === "approved");
    return (approved ?? group.members[0]).id;
  });
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const names = useMemo(
    () => Object.fromEntries(group.members.map((m) => [m.id, m.name])),
    [group.members]
  );
  const chosen = group.members.filter((m) => selected.has(m.id));
  const canConfirm = chosen.length >= 2 && selected.has(survivor);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "something went wrong");
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={group.rule === "identical_website" ? "info" : "outline"}>
            {RULE_LABEL[group.rule]}
          </Badge>
          <Badge variant="secondary">{group.is_marketplace ? "Marketplace" : "Direct"}</Badge>
          {group.sharedPlatform && (
            <Badge variant="warn">Shared platform domain, may be different sellers</Badge>
          )}
          {group.locationVariant && (
            <Badge variant="warn">Names differ by location, may be intentional</Badge>
          )}
          {group.mixedApproval && <Badge variant="warn">Approval states differ</Badge>}
        </div>
        <CardTitle className="text-base font-medium">{group.domain}</CardTitle>
        <CardDescription>
          {group.members.length} suppliers look like one company. Tick the rows that belong
          together and choose which one to keep.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-1">
          {group.members.map((m) => {
            const isIn = selected.has(m.id);
            return (
              <li
                key={m.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-primary"
                  checked={isIn}
                  disabled={!canAct || pending}
                  onChange={() => toggle(m.id)}
                  aria-label={`Include ${m.name}`}
                />
                <input
                  type="radio"
                  name={`survivor-${group.key}`}
                  className="h-4 w-4 shrink-0 accent-primary"
                  checked={survivor === m.id}
                  disabled={!canAct || pending || !isIn}
                  onChange={() => setSurvivor(m.id)}
                  aria-label={`Keep ${m.name}`}
                />
                <span className={isIn ? "text-sm" : "text-sm text-muted-foreground line-through"}>
                  {m.name}
                </span>
                <ApprovalBadge a={m.approval} />
                {survivor === m.id && isIn && <Badge variant="accent">Keep this one</Badge>}
                {m.website && (
                  <span className="ml-auto truncate text-xs text-muted-foreground" title={m.website}>
                    {m.website}
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        <p className="text-xs text-muted-foreground">
          Confirming adds this to the merge list below. It does not change anything in Tenkara;
          an operator still makes the edit there.
        </p>

        {error && <p className="text-xs text-red-600">{error}</p>}

        {canAct && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={pending || !canConfirm}
              onClick={() =>
                run(() =>
                  confirmSupplierDupe({
                    orgId,
                    slug,
                    supplierIds: chosen.map((m) => m.id),
                    names,
                    survivorId: survivor,
                  })
                )
              }
            >
              Same company
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(() =>
                  dismissSupplierDupe({
                    orgId,
                    slug,
                    supplierIds: group.members.map((m) => m.id),
                    names,
                  })
                )
              }
            >
              Not duplicates
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ConfirmedList({
  title,
  description,
  groups,
  orgId,
  slug,
  canAct,
  showResolve,
}: {
  title: string;
  description: string;
  groups: ConfirmedGroup[];
  orgId: string;
  slug: string;
  canAct: boolean;
  showResolve: boolean;
}) {
  const [pending, start] = useTransition();
  if (!groups.length) return null;
  return (
    <div className="space-y-2">
      <div>
        <h4 className="text-sm font-medium">
          {title} ({groups.length})
        </h4>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <ul className="space-y-1">
        {groups.map((g) => (
          <li
            key={g.supplierIds.join(",")}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm"
          >
            <span className="font-medium">{g.survivorId ? g.names[g.survivorId] : "(keep undecided)"}</span>
            <span className="text-xs text-muted-foreground">
              absorbs{" "}
              {g.supplierIds
                .filter((id) => id !== g.survivorId)
                .map((id) => g.names[id] ?? id)
                .join(", ")}
            </span>
            {canAct && (
              <span className="ml-auto flex gap-2">
                {showResolve && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        await markSupplierDupeResolved({ orgId, slug, supplierIds: g.supplierIds });
                      })
                    }
                  >
                    Merged in Tenkara
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      await reopenSupplierDupe({ orgId, slug, supplierIds: g.supplierIds });
                    })
                  }
                >
                  Undo
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SupplierDuplicatesSection({
  groups,
  toMerge,
  merged,
  orgId,
  slug,
  canAct,
}: {
  groups: DupeGroup[];
  toMerge: ConfirmedGroup[];
  merged: ConfirmedGroup[];
  orgId: string;
  slug: string;
  canAct?: boolean;
}) {
  const [showMerged, setShowMerged] = useState(false);
  if (!groups.length && !toMerge.length && !merged.length) return null;

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold">Possible duplicates</h3>
        <p className="text-sm text-muted-foreground">
          Suppliers that look like the same company recorded more than once. A supplier kept once
          as a marketplace and once as direct is not counted here.
        </p>
      </div>

      {groups.length > 0 ? (
        <div className="space-y-3">
          {groups.map((g) => (
            <GroupCard key={g.key} group={g} orgId={orgId} slug={slug} canAct={!!canAct} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing left to review.</p>
      )}

      <ConfirmedList
        title="To merge in Tenkara"
        description="Confirmed as one company. Make the edit in Tenkara, then mark it done."
        groups={toMerge}
        orgId={orgId}
        slug={slug}
        canAct={!!canAct}
        showResolve
      />

      {merged.length > 0 && (
        <div className="space-y-2">
          <Button size="sm" variant="ghost" onClick={() => setShowMerged((v) => !v)}>
            {showMerged ? "Hide" : "Show"} merged ({merged.length})
          </Button>
          {showMerged && (
            <ConfirmedList
              title="Already merged"
              description="Marked as done in Tenkara."
              groups={merged}
              orgId={orgId}
              slug={slug}
              canAct={!!canAct}
              showResolve={false}
            />
          )}
        </div>
      )}
    </section>
  );
}
