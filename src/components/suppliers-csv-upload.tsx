"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { uploadSuppliersCsv, type CsvUploadResult } from "@/app/actions/leads";

// Ops bulk-upload of suppliers into a client's outreach queue. CSV columns:
// supplier, email, material (+ optional contact_name, website, country).
export function SuppliersCsvUpload({ orgId }: { orgId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [res, setRes] = useState<CsvUploadResult | null>(null);

  function onPick(file: File) {
    setRes(null);
    const fd = new FormData();
    fd.set("file", file);
    start(async () => {
      const r = await uploadSuppliersCsv(orgId, fd);
      setRes(r);
      if (r.ok) router.refresh();
      if (fileRef.current) fileRef.current.value = "";
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
        }}
      />
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => fileRef.current?.click()}>
        {pending ? "Uploading…" : "Upload suppliers CSV"}
      </Button>
      {res && (
        <span className="text-xs">
          {res.ok ? (
            <span className="text-muted-foreground">
              Added <span className="font-medium text-foreground">{res.inserted}</span>
              {res.skippedDuplicate ? ` · ${res.skippedDuplicate} dup` : ""}
              {res.skippedFuzzyDuplicate ? ` · ${res.skippedFuzzyDuplicate} likely dup (name match)` : ""}
              {res.skippedNoMatch ? ` · ${res.skippedNoMatch} no material match` : ""}
              {res.skippedNoEmail ? ` · ${res.skippedNoEmail} bad email` : ""}
              {res.unmatchedSample && res.unmatchedSample.length > 0 ? ` (e.g. ${res.unmatchedSample.slice(0, 3).join(", ")})` : ""}
            </span>
          ) : (
            <span className="text-red-600 dark:text-red-400">{res.error}</span>
          )}
        </span>
      )}
    </div>
  );
}
