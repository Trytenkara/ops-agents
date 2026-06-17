"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Select } from "@/components/ui/select";

// Filter row for Price Pulse: styled Client dropdown (no native OS select),
// material typeahead, and a min-quotes threshold. Navigates via router so the
// server page re-runs with the new params.

type ClientOption = { slug: string; name: string };

export function PricePulseFilters({
  clients,
  selectedClient,
  material,
  minQuotes,
}: {
  clients: ClientOption[];
  selectedClient: string;
  material: string;
  minQuotes: number;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/work/price-pulse";
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const [matInput, setMatInput] = useState(material);
  const [minInput, setMinInput] = useState(String(minQuotes));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setMatInput(material), [material]);
  useEffect(() => setMinInput(String(minQuotes)), [minQuotes]);

  function pushParams(mutate: (sp: URLSearchParams) => void) {
    const sp = new URLSearchParams(searchParams?.toString() ?? "");
    mutate(sp);
    const qs = sp.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname));
  }

  function setClient(value: string) {
    pushParams((sp) => (value ? sp.set("client", value) : sp.delete("client")));
  }

  function scheduleMaterial(value: string) {
    setMatInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushParams((sp) => {
        const v = value.trim();
        if (v) sp.set("q", v);
        else sp.delete("q");
      });
    }, 300);
  }

  function submitMin() {
    pushParams((sp) => {
      const v = parseInt(minInput, 10);
      if (Number.isFinite(v) && v >= 2) sp.set("min", String(v));
      else sp.delete("min");
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Client</span>
        <Select
          size="sm"
          className="min-w-[13rem]"
          ariaLabel="Filter by client"
          value={selectedClient}
          onValueChange={setClient}
          options={[{ value: "", label: "All clients" }, ...clients.map((c) => ({ value: c.slug, label: c.name }))]}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Material</span>
        <input
          value={matInput}
          onChange={(e) => scheduleMaterial(e.target.value)}
          placeholder="Filter materials…"
          className="h-8 w-56 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground" title="Hide materials with fewer than this many quotes — filters out thin, noisy data.">
          Min quotes
        </span>
        <input
          value={minInput}
          inputMode="numeric"
          onChange={(e) => setMinInput(e.target.value)}
          onBlur={submitMin}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitMin();
            }
          }}
          className="h-8 w-20 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </label>
    </div>
  );
}
