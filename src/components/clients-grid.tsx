"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";

type Org = { slug: string; name: string; is_internal: boolean };

// Searchable, filterable client index — the surface that scales to hundreds of
// clients (the sidebar only shows a capped quick-list). Client-side filter keeps
// it instant; pagination can layer on if the org count grows past a few hundred.
export function ClientsGrid({ orgs }: { orgs: Org[] }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const filtered = needle ? orgs.filter((o) => o.name.toLowerCase().includes(needle)) : orgs;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search clients…"
          className="w-full max-w-sm rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {filtered.length}{filtered.length !== orgs.length ? ` of ${orgs.length}` : ""}
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No clients match “{q}”.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((o) => (
            <Link key={o.slug} href={`/work/orgs/${o.slug}`}>
              <Card className="tb-surface shadow-none transition-colors hover:border-foreground/30">
                <CardContent className="py-5">
                  <div className="font-medium">{o.name}</div>
                  <div className="text-xs text-muted-foreground mt-1">{o.is_internal ? "Internal" : "Client workspace"}</div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
