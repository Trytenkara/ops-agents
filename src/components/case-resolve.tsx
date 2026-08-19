"use client";
import { useState, useTransition } from "react";
import { resolveCase, addSupplierEmailToCase, rejectSupplierFromCase, removeContactFromCase } from "@/app/actions/cases";

export function CaseResolve({
  caseId,
  canAddEmail = false,
  canReject = false,
  canRemoveContact = false,
}: {
  caseId: string;
  canAddEmail?: boolean;
  canReject?: boolean;
  canRemoveContact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [email, setEmail] = useState("");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function onResolve() {
    setErr(null);
    start(async () => {
      const r = await resolveCase(caseId, note);
      if (!r.ok) setErr(r.error);
      else setOpen(false);
    });
  }

  function onReject() {
    setErr(null);
    start(async () => {
      const r = await rejectSupplierFromCase(caseId, note);
      if (!r.ok) setErr(r.error);
      else setOpen(false);
    });
  }

  function onRemoveContact() {
    setErr(null);
    start(async () => {
      const r = await removeContactFromCase(caseId);
      if (!r.ok) setErr(r.error);
      else setOpen(false);
    });
  }

  function onAddEmail() {
    setErr(null);
    start(async () => {
      const r = await addSupplierEmailToCase(caseId, email);
      if (!r.ok) setErr(r.error);
      else setOpen(false);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
      >
        Resolve
      </button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-2">
      {canAddEmail && (
        <div className="flex items-center gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="supplier@company.com"
            className="border border-border rounded-md px-2 py-1 text-xs w-56"
          />
          <button
            type="button"
            onClick={onAddEmail}
            disabled={pending || !email.trim()}
            className="rounded-md bg-primary text-primary-foreground px-2 py-1 text-xs disabled:opacity-50"
          >
            {pending ? "…" : "Add email & requeue"}
          </button>
        </div>
      )}
      {canRemoveContact && (
        <button
          type="button"
          onClick={onRemoveContact}
          disabled={pending}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          title="Retires this address only. The supplier and its lead stay, and the contact hunt looks for a new address."
        >
          {pending ? "…" : "Bad contact, remove the address"}
        </button>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Resolution note (optional)"
          className="border border-border rounded-md px-2 py-1 text-xs w-56"
        />
        <button
          type="button"
          onClick={onResolve}
          disabled={pending}
          className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          {pending ? "…" : "Done"}
        </button>
        {canReject && (
          <button
            type="button"
            onClick={onReject}
            disabled={pending}
            className="rounded-md border border-destructive text-destructive px-2 py-1 text-xs hover:bg-destructive/10 disabled:opacity-50"
            title="Adds the supplier to this client's do-not-contact list"
          >
            {pending ? "…" : "Not a fit, stop contacting"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </div>
  );
}
