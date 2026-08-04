"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { DOC_EDITABLE_FIELDS, mergedDocFields, type DocType } from "@/lib/supplier-documents";

export const DOC_TYPE_LABEL: Record<string, string> = {
  coa: "CoA",
  sds: "SDS",
  tds: "TDS",
  certificate: "Certificate",
  statement: "Statement",
  testing: "Testing",
  price_sheet: "Price sheet",
  other: "Document",
};

export interface DocumentRowDoc {
  id: string;
  doc_type: string;
  supplier_name: string | null;
  source_url: string | null;
  expires_on: string | null;
  extracted: Record<string, any> | null;
  extracted_overrides: Record<string, any> | null;
  extracted_edited_by: string | null;
  storage_path: string | null;
  source_kind: string | null;
  supplier_issued: boolean | null;
}

// A one-line summary of the fields parsed out of a document, chosen per type.
// Reads corrections on top of the parse, so an edit shows here immediately.
function docSummary(d: DocumentRowDoc): string | null {
  const f = mergedDocFields(d);
  const parts: string[] = [];
  switch (d.doc_type) {
    case "coa":
      if (f.assay_percent != null) parts.push(`${f.assay_percent}% assay`);
      if (f.grade) parts.push(String(f.grade));
      if (f.lot_number) parts.push(`lot ${f.lot_number}`);
      break;
    case "certificate":
      if (f.certificate_type) parts.push(String(f.certificate_type));
      if (f.certificate_number) parts.push(`#${f.certificate_number}`);
      if (f.issuer) parts.push(String(f.issuer));
      break;
    case "sds":
      if (f.cas_number) parts.push(`CAS ${f.cas_number}`);
      if (f.revision_date) parts.push(`rev ${f.revision_date}`);
      break;
    case "statement":
      if (f.statement_type) parts.push(String(f.statement_type));
      else if (f.summary) parts.push(String(f.summary));
      break;
    case "testing":
      if (f.test_type) parts.push(String(f.test_type));
      if (f.result_summary) parts.push(String(f.result_summary));
      break;
    default:
      if (f.summary) parts.push(String(f.summary));
  }
  return parts.length ? parts.join(" · ") : null;
}

function expiryStatus(expiresOn: string | null): { label: string; tone: "expired" | "soon" | "ok" } | null {
  if (!expiresOn) return null;
  const exp = new Date(expiresOn + "T00:00:00Z").getTime();
  if (!Number.isFinite(exp)) return null;
  const days = Math.round((exp - Date.now()) / 86_400_000);
  if (days < 0) return { label: "expired", tone: "expired" };
  if (days <= 30) return { label: `${days}d left`, tone: "soon" };
  return { label: "valid", tone: "ok" };
}

export function DocumentRow({ doc }: { doc: DocumentRowDoc }) {
  const router = useRouter();
  const spec = DOC_EDITABLE_FIELDS[doc.doc_type as DocType] ?? [];
  const merged = mergedDocFields(doc);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});

  const open = () => {
    const init: Record<string, string> = { expires_on: doc.expires_on ?? "" };
    for (const f of spec) init[f.key] = merged[f.key] == null ? "" : String(merged[f.key]);
    setForm(init);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/supplier-documents/${doc.id}/fields`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: form }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? `save failed (${res.status})`);
        return;
      }
      setEditing(false);
      router.refresh();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const summary = docSummary(doc);
  const exp = expiryStatus(doc.expires_on);
  const editedKeys = Object.keys(doc.extracted_overrides ?? {});
  const viewable = !!doc.storage_path || /^https?:\/\//i.test(doc.source_url ?? "");

  return (
    <li className="px-4 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {DOC_TYPE_LABEL[doc.doc_type] ?? doc.doc_type}
          </span>
          <span className="truncate text-sm">
            {doc.supplier_name ?? "Unknown supplier"}
            {summary && <span className="ml-2 text-xs text-muted-foreground">{summary}</span>}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {editedKeys.length > 0 && (
            <span
              className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary"
              title={`Corrected by ${doc.extracted_edited_by ?? "an operator"}: ${editedKeys.join(", ")}`}
            >
              edited
            </span>
          )}
          {exp && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider",
                exp.tone === "expired"
                  ? "bg-destructive/10 text-destructive"
                  : exp.tone === "soon"
                  ? "bg-amber-500/10 text-amber-600"
                  : "bg-emerald-500/10 text-emerald-600"
              )}
            >
              {exp.label}
            </span>
          )}
          {doc.source_kind === "web" && doc.supplier_issued === false && (
            <span
              className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
              title="Third-party reference copy, not issued by this supplier. Useful chemistry, but it does not qualify the vendor."
            >
              reference
            </span>
          )}
          <button
            type="button"
            onClick={() => (editing ? setEditing(false) : open())}
            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          >
            {editing ? "Cancel" : "Edit fields"}
          </button>
          {viewable && (
            <a
              href={`/api/supplier-documents/${doc.id}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            >
              View
            </a>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-3 space-y-3 rounded-lg border border-border bg-secondary/30 p-3">
          <p className="text-xs text-muted-foreground">
            These fields were read off the document by the parser and are often incomplete. Corrections are kept
            separately, so re-reading the file will not overwrite them.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {spec.map((f) => {
              const corrected = f.key in (doc.extracted_overrides ?? {});
              return (
                <label key={f.key} className="space-y-1">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {f.label}
                    {corrected && <span className="text-[10px] uppercase tracking-wider text-primary">edited</span>}
                  </span>
                  <Input
                    type={f.kind === "date" ? "date" : f.kind === "number" ? "number" : "text"}
                    step={f.kind === "number" ? "any" : undefined}
                    value={form[f.key] ?? ""}
                    onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                    placeholder="not stated"
                  />
                </label>
              );
            })}
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Expiry / valid until</span>
              <Input
                type="date"
                value={form.expires_on ?? ""}
                onChange={(e) => setForm((s) => ({ ...s, expires_on: e.target.value }))}
              />
            </label>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
