"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Select } from "@/components/ui/select";

// Filter bar for /work/leads. Renders the org dropdown + material typeahead.
// Updates URL params via router.replace so the server page re-runs with the new
// filters. Source/stage/drift chips remain rendered server-side (they're plain
// Links), so this component only owns the inputs that need client interactivity.

type OrgOption = { id: string; slug: string; name: string };

export function LeadsFilterBar({
  orgs,
  selectedOrgId,
  material,
}: {
  orgs: OrgOption[];
  selectedOrgId: string;
  material: string;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/work/review/leads";
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const [matInput, setMatInput] = useState(material);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local input if URL changes externally (e.g. back/forward nav).
  useEffect(() => { setMatInput(material); }, [material]);

  function pushParams(mutate: (sp: URLSearchParams) => void) {
    const sp = new URLSearchParams(searchParams?.toString() ?? "");
    mutate(sp);
    // Any filter change resets pagination.
    sp.delete("page");
    const qs = sp.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname));
  }

  function setOrg(value: string) {
    pushParams((sp) => {
      if (value) sp.set("org", value);
      else sp.delete("org");
    });
  }

  function scheduleMaterial(value: string) {
    setMatInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushParams((sp) => {
        const v = value.trim();
        if (v) sp.set("material", v);
        else sp.delete("material");
      });
    }, 300);
  }

  function submitMaterial() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    pushParams((sp) => {
      const v = matInput.trim();
      if (v) sp.set("material", v);
      else sp.delete("material");
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground">Org:</span>
        <Select
          size="sm"
          className="min-w-[11rem]"
          ariaLabel="Filter by org"
          value={selectedOrgId}
          onValueChange={setOrg}
          options={[
            { value: "", label: "All my orgs" },
            ...orgs.map((o) => ({ value: o.slug, label: o.name })),
          ]}
        />
      </label>

      <form
        onSubmit={(e) => { e.preventDefault(); submitMaterial(); }}
        className="flex items-center gap-1"
      >
        <span className="text-xs text-muted-foreground">Material:</span>
        <div className="relative">
          <input
            value={matInput}
            onChange={(e) => scheduleMaterial(e.target.value)}
            placeholder="name or INCI…"
            className="h-8 w-56 rounded-md border border-input bg-transparent px-2 pr-7 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          {matInput && (
            <button
              type="button"
              onClick={() => { setMatInput(""); pushParams((sp) => sp.delete("material")); }}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-base leading-none px-1"
              title="Clear material filter"
              aria-label="Clear material filter"
            >×</button>
          )}
        </div>
      </form>
    </div>
  );
}
