"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useListFilter, byString } from "@/components/use-list-filter";
import { leadMarketKind } from "@/components/lead-rich-row";
import { saveLeadPriceTiers } from "@/app/actions/leads";
import type { PriceTier } from "@/lib/price-tiers";

// Marketplace-only view: suppliers whose pricing is published directly on their
// own site/storefront (site_type M = checkout no-signup, MS = checkout after
// registration). Ops can structure the published price ladder into tiers
// (pack size → price → $/unit) and edit them inline.

type Row = {
  id: string;
  supplier_name: string | null;
  material_name: string | null;
  source: string | null;
  market_kind?: "marketplace" | "direct" | null;
  payload: any;
};

function isMarketplace(r: Row): boolean {
  return (r.market_kind ?? leadMarketKind(r.payload?.site_type)) === "marketplace";
}

function siteTypeMeta(st: string | null | undefined): { label: string; title: string } | null {
  if (st === "M") return { label: "Open checkout", title: "Marketplace — public price, checkout without signup" };
  if (st === "MS") return { label: "Checkout after signup", title: "Marketplace — price visible after registration" };
  return null;
}

export function MarketplacePricing({ rows, canAct, slug }: { rows: Row[]; canAct: boolean; slug: string }) {
  const marketRows = rows.filter(isMarketplace);

  const { filtered, controls } = useListFilter(marketRows, {
    searchText: (r) => `${r.supplier_name ?? ""} ${r.material_name ?? ""}`,
    searchPlaceholder: "supplier or material…",
    sorts: [
      { value: "supplier", label: "Supplier (A–Z)", compare: byString((r: Row) => r.supplier_name) },
      { value: "material", label: "Material (A–Z)", compare: byString((r: Row) => r.material_name) },
    ],
    defaultSort: "supplier",
  });

  if (marketRows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No marketplace leads yet. These appear when Scout finds suppliers with published website pricing (open checkout
        or checkout-after-signup).
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">{controls}</div>
      <p className="text-xs text-muted-foreground">
        {filtered.length} marketplace supplier{filtered.length === 1 ? "" : "s"} with direct website pricing. Structure
        each published price ladder into tiers — pack size, total price, and the derived $/unit.
      </p>
      <div className="space-y-3">
        {filtered.map((r) => (
          <MarketplaceLeadCard key={r.id} row={r} canAct={canAct} />
        ))}
        {filtered.length === 0 && <p className="text-sm text-muted-foreground py-4">No marketplace leads match.</p>}
      </div>
    </div>
  );
}

function emptyTier(): PriceTier {
  return { pack_size: "", price: null, unit_price: null };
}

function MarketplaceLeadCard({ row, canAct }: { row: Row; canAct: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const initial: PriceTier[] = Array.isArray(row.payload?.price_tiers) && row.payload.price_tiers.length
    ? row.payload.price_tiers.map((t: any) => ({
        pack_size: t.pack_size ?? "",
        price: t.price ?? null,
        unit_price: t.unit_price ?? null,
      }))
    : [emptyTier()];
  const [tiers, setTiers] = useState<PriceTier[]>(initial);

  const st = siteTypeMeta(row.payload?.site_type);
  const pull = row.payload?.marketplace_pull as
    | { status: "pulled" | "needs_manual_pull"; reason?: string; pulled_at?: string }
    | undefined;
  const pullReasonLabel: Record<string, string> = {
    login_required: "needs login/account",
    link_broken: "link broken",
    needs_review: "no price found",
  };
  const sourceUrl = (row.payload?.source_url ?? row.payload?.supplier_website) as string | undefined;
  const rawPricing = row.payload?.pack_sizes_pricing as string | undefined;
  const moq = row.payload?.moq as string | undefined;
  const updatedAt = row.payload?.price_tiers_updated_at as string | undefined;

  function setTier(i: number, patch: Partial<PriceTier>) {
    setTiers((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }
  function addTier() {
    setTiers((prev) => [...prev, emptyTier()]);
  }
  function removeTier(i: number) {
    setTiers((prev) => (prev.length <= 1 ? [emptyTier()] : prev.filter((_, idx) => idx !== i)));
  }
  function save() {
    setMsg(null);
    start(async () => {
      const r = await saveLeadPriceTiers(row.id, tiers);
      if (r.ok) setMsg({ kind: "ok", text: "Saved" });
      else setMsg({ kind: "err", text: r.error ?? "failed" });
      router.refresh();
    });
  }

  const num = (v: number | null) => (v == null ? "" : String(v));
  const toNum = (s: string): number | null => {
    const t = s.trim();
    if (t === "") return null;
    const n = Number(t.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{row.supplier_name ?? "—"}</span>
            {st && <Badge variant="accent" title={st.title}>{st.label}</Badge>}
            {pull?.status === "pulled" && (
              <Badge variant="success" title={pull.pulled_at ? `Auto-pulled ${pull.pulled_at}` : "Price auto-pulled from the listing"}>
                price auto-pulled
              </Badge>
            )}
            {pull?.status === "needs_manual_pull" && (
              <Badge variant="warn" title="Auto-pull couldn't get a price — an operator was tagged to pull it manually.">
                needs manual pull{pull.reason ? ` · ${pullReasonLabel[pull.reason] ?? pull.reason}` : ""}
              </Badge>
            )}
            {!pull && (
              <Badge variant="outline" title="Not checked yet — the marketplace price agent will attempt to pull the listed price. You can also enter the price ladder manually now.">
                price pull pending
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">· {row.material_name ?? "—"}</span>
          </div>
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-xs text-primary hover:underline truncate max-w-[44ch]"
              title={sourceUrl}
            >
              {sourceUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
            </a>
          )}
        </div>
        <div className="text-right text-[11px] text-muted-foreground">
          {(rawPricing || moq) && (
            <div className="max-w-[36ch]">
              {rawPricing && <div title="What Scout captured off the listing"><span className="font-medium text-foreground">Listed:</span> {rawPricing}</div>}
              {moq && <div><span className="font-medium text-foreground">MOQ:</span> {moq}</div>}
            </div>
          )}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40%]">Pack size</TableHead>
            <TableHead className="w-[24%]">Price (total)</TableHead>
            <TableHead className="w-[24%]">$ / unit</TableHead>
            <TableHead className="w-[12%] text-right">{canAct ? "" : ""}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tiers.map((t, i) => (
            <TableRow key={i}>
              <TableCell>
                <Input
                  value={t.pack_size ?? ""}
                  disabled={!canAct || pending}
                  placeholder="e.g. 25 kg drum"
                  onChange={(e) => setTier(i, { pack_size: e.target.value })}
                />
              </TableCell>
              <TableCell>
                <Input
                  inputMode="decimal"
                  value={num(t.price)}
                  disabled={!canAct || pending}
                  placeholder="450.00"
                  onChange={(e) => setTier(i, { price: toNum(e.target.value) })}
                />
              </TableCell>
              <TableCell>
                <Input
                  inputMode="decimal"
                  value={num(t.unit_price)}
                  disabled={!canAct || pending}
                  placeholder="18.00"
                  onChange={(e) => setTier(i, { unit_price: toNum(e.target.value) })}
                />
              </TableCell>
              <TableCell className="text-right">
                {canAct && (
                  <button
                    type="button"
                    className="text-red-600 hover:underline text-xs disabled:opacity-50"
                    disabled={pending}
                    onClick={() => removeTier(i)}
                    aria-label="Remove tier"
                  >
                    remove
                  </button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {canAct && (
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" disabled={pending} onClick={addTier}>
            + Add tier
          </Button>
          <Button size="sm" disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save tiers"}
          </Button>
          {updatedAt && !msg && (
            <span className="text-[11px] text-muted-foreground">Last edited {new Date(updatedAt).toLocaleDateString()}</span>
          )}
          {msg && (
            <span className={msg.kind === "ok" ? "text-xs text-emerald-600" : "text-xs text-red-600"}>{msg.text}</span>
          )}
        </div>
      )}
    </div>
  );
}
