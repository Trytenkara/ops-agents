"use client";

import { useState } from "react";
import { cn, relativeTime } from "@/lib/utils";

export type MarketplaceAccount = {
  id: string;
  host: string;
  signup_email: string | null;
  password: string | null;
  status: string;
  last_error: string | null;
  verified_at: string | null;
  last_login_at: string | null;
  created_at: string;
};

// Lifecycle → badge styling + human label. Mirrors the marketplace_accounts
// status column the provision/pull scripts write.
const STATUS: Record<string, { label: string; cls: string; hint: string }> = {
  active: { label: "Active", cls: "bg-emerald-500/15 text-emerald-600 ring-emerald-500/30", hint: "Confirmed — the agent logs in and pulls gated prices automatically." },
  verifying: { label: "Awaiting confirm", cls: "bg-amber-500/15 text-amber-600 ring-amber-500/30", hint: "Signup accepted. Click the confirmation link in the email sent to the purchasing inbox, then this flips to Active." },
  signing_up: { label: "Signing up", cls: "bg-blue-500/15 text-blue-600 ring-blue-500/30", hint: "The agent is creating this account right now." },
  pending: { label: "Pending", cls: "bg-slate-500/15 text-slate-500 ring-slate-500/30", hint: "Queued for provisioning." },
  banned: { label: "Banned", cls: "bg-destructive/15 text-destructive ring-destructive/30", hint: "The marketplace blocked this account." },
  failed: { label: "Failed", cls: "bg-destructive/10 text-destructive ring-destructive/20", hint: "Signup could not complete — see the error." },
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border hover:bg-secondary hover:text-foreground"
      title={`Copy ${label}`}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Secret({ value }: { value: string | null }) {
  const [shown, setShown] = useState(false);
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{shown ? value : "•".repeat(Math.min(value.length, 12))}</code>
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border hover:bg-secondary hover:text-foreground"
      >
        {shown ? "Hide" : "Show"}
      </button>
      <CopyButton value={value} label="password" />
    </span>
  );
}

export function MarketplaceLogins({ accounts }: { accounts: MarketplaceAccount[] }) {
  const [open, setOpen] = useState(false);
  if (!accounts.length) return null;

  const active = accounts.filter((a) => a.status === "active").length;
  const verifying = accounts.filter((a) => a.status === "verifying").length;

  return (
    <div className="rounded-xl border border-border bg-card/50">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">Marketplace Logins</span>
          <span className="text-xs text-muted-foreground">
            {accounts.length} account{accounts.length > 1 ? "s" : ""}
            {active > 0 && <span className="text-emerald-600"> · {active} active</span>}
            {verifying > 0 && <span className="text-amber-600"> · {verifying} awaiting confirm</span>}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3">
          <p className="mb-3 text-xs text-muted-foreground">
            Accounts the agent auto-created on login-gated marketplaces to pull pricing. Where a login shows
            &quot;Awaiting confirm&quot;, click the confirmation link in the email sent to the purchasing inbox to activate it.
            Credentials are here so ops can log in manually if needed.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Marketplace</th>
                  <th className="py-1.5 pr-3 font-medium">Email</th>
                  <th className="py-1.5 pr-3 font-medium">Password</th>
                  <th className="py-1.5 pr-3 font-medium">Status</th>
                  <th className="py-1.5 pr-3 font-medium">Last login</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const s = STATUS[a.status] ?? { label: a.status, cls: "bg-secondary text-muted-foreground ring-border", hint: "" };
                  return (
                    <tr key={a.id} className="border-b border-border/50 align-top">
                      <td className="py-2 pr-3">
                        <a href={`https://${a.host}`} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground hover:underline">
                          {a.host}
                        </a>
                      </td>
                      <td className="py-2 pr-3">
                        {a.signup_email ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className="text-foreground">{a.signup_email}</span>
                            <CopyButton value={a.signup_email} label="email" />
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <Secret value={a.password} />
                      </td>
                      <td className="py-2 pr-3">
                        <span className={cn("inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ring-1", s.cls)} title={s.hint}>
                          {s.label}
                        </span>
                        {a.status === "failed" && a.last_error && (
                          <div className="mt-1 max-w-[16rem] text-[11px] text-muted-foreground">{a.last_error}</div>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {a.last_login_at ? relativeTime(a.last_login_at) : a.verified_at ? `confirmed ${relativeTime(a.verified_at)}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
