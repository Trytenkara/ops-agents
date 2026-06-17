"use client";

import { useMemo, useState } from "react";
import { Select } from "@/components/ui/select";

// Reusable client-side search + sort for per-client list tables. Pages pass
// serializable rows; this filters by a text needle over caller-chosen fields
// and sorts by a labeled option. Keeps long lists navigable without per-page
// bespoke filtering.

export type SortOption<T> = { value: string; label: string; compare: (a: T, b: T) => number };

export function useListFilter<T>(
  rows: T[],
  opts: {
    searchText: (row: T) => string;
    searchPlaceholder?: string;
    sorts: SortOption<T>[];
    defaultSort?: string;
  }
): { filtered: T[]; controls: React.ReactNode } {
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState(opts.defaultSort ?? opts.sorts[0]?.value ?? "");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = needle ? rows.filter((r) => opts.searchText(r).toLowerCase().includes(needle)) : rows;
    const s = opts.sorts.find((x) => x.value === sortKey);
    if (s) out = [...out].sort(s.compare);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, sortKey]);

  const controls = (
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Search</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={opts.searchPlaceholder ?? "supplier or material…"}
          className="h-8 w-64 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </label>
      {opts.sorts.length > 0 && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Sort by</span>
          <Select
            size="sm"
            className="min-w-[11rem]"
            ariaLabel="Sort"
            value={sortKey}
            onValueChange={setSortKey}
            options={opts.sorts.map((s) => ({ value: s.value, label: s.label }))}
          />
        </label>
      )}
      <span className="text-xs text-muted-foreground pb-1.5">
        {filtered.length} of {rows.length}
      </span>
    </div>
  );

  return { filtered, controls };
}

// Common comparators.
export function byString<T>(get: (r: T) => string | null | undefined) {
  return (a: T, b: T) => (get(a) ?? "").localeCompare(get(b) ?? "");
}
export function byNumberDesc<T>(get: (r: T) => number | null | undefined) {
  return (a: T, b: T) => (get(b) ?? -Infinity) - (get(a) ?? -Infinity);
}
export function byDateDesc<T>(get: (r: T) => string | null | undefined) {
  return (a: T, b: T) => (get(b) ?? "").localeCompare(get(a) ?? "");
}
