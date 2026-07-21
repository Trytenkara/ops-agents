"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { resetClientData } from "@/app/actions/admin-reset";

// Admin-only per-client data reset. Two-step: pick a client, then type DELETE to
// confirm. Irreversible — wipes the client's OA working data (leads, drafts,
// POs, quotes, cases, settings/profile/notes). Tenkara data is untouched.
export function ResetClientData({ orgs }: { orgs: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [orgId, setOrgId] = useState("");
  const [confirm, setConfirm] = useState("");
  const [arming, setArming] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const selectedName = orgs.find((o) => o.id === orgId)?.name ?? "";
  const options = [{ value: "", label: "Select a client…" }, ...orgs.map((o) => ({ value: o.id, label: o.name }))];

  function run() {
    setMsg(null);
    start(async () => {
      const r = await resetClientData(orgId, confirm);
      if (r.ok) {
        const total = Object.values(r.cleared ?? {}).reduce((a, b) => a + b, 0);
        setMsg({ kind: "ok", text: `Reset "${selectedName}" — ${total} row(s) cleared across ${Object.keys(r.cleared ?? {}).length} tables.` });
        setArming(false);
        setConfirm("");
        setOrgId("");
        router.refresh();
      } else {
        setMsg({ kind: "err", text: r.error ?? "failed" });
      }
    });
  }

  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 space-y-3">
      <div>
        <div className="text-sm font-medium text-destructive">Reset a client&apos;s data</div>
        <p className="text-xs text-muted-foreground mt-1">
          Permanently clears this client&apos;s leads, drafts/threads, uploaded POs, collected quotes, cases, and
          settings/profile/notes so its sourcing can be re-run from scratch. <span className="font-medium">Cannot be undone.</span>{" "}
          The client&apos;s Tenkara materials, suppliers, and quotes are not touched.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Client</span>
          <Select
            size="sm"
            className="min-w-[16rem]"
            ariaLabel="Client to reset"
            value={orgId}
            onValueChange={(v) => { setOrgId(v); setArming(false); setMsg(null); }}
            options={options}
          />
        </label>

        {!arming ? (
          <Button size="sm" variant="destructive" disabled={!orgId || pending} onClick={() => setArming(true)}>
            Reset this client
          </Button>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Type DELETE to confirm</span>
              <input
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="DELETE"
                className="h-8 w-40 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>
            <Button size="sm" variant="destructive" disabled={confirm !== "DELETE" || pending} onClick={run}>
              {pending ? "Resetting…" : `Wipe ${selectedName || "client"}`}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setArming(false); setConfirm(""); }}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      {msg && <p className={msg.kind === "ok" ? "text-xs text-green-700" : "text-xs text-destructive"}>{msg.text}</p>}
    </div>
  );
}
