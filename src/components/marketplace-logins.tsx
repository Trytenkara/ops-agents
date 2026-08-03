"use client";

import { useState, useTransition } from "react";
import { cn, relativeTime } from "@/lib/utils";
import {
  createMarketplaceAccount,
  updateMarketplaceAccount,
  deleteMarketplaceAccount,
} from "@/app/actions/marketplace-accounts";

export type MarketplaceAccount = {
  id: string;
  supplier_profile_id: string | null;
  host: string;
  signup_email: string | null;
  password: string | null;
  status: string;
  last_error: string | null;
  verified_at: string | null;
  last_login_at: string | null;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
};

export type SupplierOption = { id: string; name: string };

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

// Statuses an operator can pick. The agent-only transitional states
// (signing_up, verifying, pending) stay out of the form.
const OPS_STATUS_OPTIONS = [
  { value: "active", label: "Active — login works" },
  { value: "failed", label: "Not working" },
  { value: "banned", label: "Blocked by the marketplace" },
];

function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, cls: "bg-secondary text-muted-foreground ring-border", hint: "" };
  return (
    <span className={cn("inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ring-1", s.cls)} title={s.hint}>
      {s.label}
    </span>
  );
}

// Who created the credentials: the fleet, or a named operator. Ops-entered
// logins are the ones a human can vouch for, so the distinction is worth a chip.
function OriginBadge({ account }: { account: MarketplaceAccount }) {
  const byOps = account.created_by === "ops";
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
        byOps ? "bg-violet-500/15 text-violet-600 ring-violet-500/30" : "bg-sky-500/15 text-sky-600 ring-sky-500/30"
      )}
      title={byOps ? `Added by ${account.created_by_email ?? "an ops operator"}` : "Auto-created by the price-pull agent"}
    >
      {byOps ? "Ops" : "Agent"}
    </span>
  );
}

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

const inputCls =
  "h-7 w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// Add / edit one login. `supplierOptions` renders a supplier picker (org-wide
// panel); omit it when the form is already scoped to one supplier's card.
function AccountForm({
  orgId,
  account,
  supplierProfileId,
  supplierOptions,
  onDone,
}: {
  orgId: string;
  account?: MarketplaceAccount;
  supplierProfileId?: string | null;
  supplierOptions?: SupplierOption[];
  onDone: () => void;
}) {
  const [host, setHost] = useState(account?.host ?? "");
  const [email, setEmail] = useState(account?.signup_email ?? "");
  const [password, setPassword] = useState(account?.password ?? "");
  const [status, setStatus] = useState(account?.status ?? "active");
  const [supplier, setSupplier] = useState(account?.supplier_profile_id ?? supplierProfileId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const payload = { host, signupEmail: email, password, status, supplierProfileId: supplier || null };
      const res = account
        ? await updateMarketplaceAccount(account.id, orgId, payload)
        : await createMarketplaceAccount(orgId, payload);
      if (res.ok) onDone();
      else setError(res.error ?? "save failed");
    });
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-secondary/40 p-3">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
        <label className="space-y-0.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Marketplace site</span>
          <input className={inputCls} value={host} onChange={(e) => setHost(e.target.value)} placeholder="knowde.com" />
        </label>
        <label className="space-y-0.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Account email</span>
          <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="purchasing@client.com" />
        </label>
        <label className="space-y-0.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Password</span>
          <input className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="account password" />
        </label>
        <label className="space-y-0.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Status</span>
          <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
            {OPS_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {!OPS_STATUS_OPTIONS.some((o) => o.value === status) && (
              <option value={status}>{STATUS[status]?.label ?? status}</option>
            )}
          </select>
        </label>
      </div>
      {supplierOptions && (
        <label className="block space-y-0.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Supplier (optional)</span>
          <select className={inputCls} value={supplier} onChange={(e) => setSupplier(e.target.value)}>
            <option value="">Not linked to a supplier</option>
            {supplierOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Saving..." : account ? "Save login" : "Add login"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md px-2.5 py-1 text-xs text-muted-foreground ring-1 ring-border hover:bg-secondary"
        >
          Cancel
        </button>
        <span className="text-[11px] text-muted-foreground">
          Saved credentials are visible to ops and used by the price-pull agent to log in.
        </span>
      </div>
    </div>
  );
}

function DeleteButton({ accountId, orgId }: { accountId: string; orgId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border hover:bg-secondary hover:text-destructive"
      >
        Remove
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(async () => { await deleteMarketplaceAccount(accountId, orgId); })}
        className="rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive ring-1 ring-destructive/40 hover:bg-destructive/10"
      >
        {pending ? "..." : "Confirm"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border"
      >
        No
      </button>
    </span>
  );
}

// Compact list + add form for a single marketplace supplier, rendered inside its
// Supplier Validation card.
export function SupplierMarketplaceLogins({
  accounts,
  orgId,
  supplierProfileId,
  canAct,
}: {
  accounts: MarketplaceAccount[];
  orgId: string;
  supplierProfileId: string;
  canAct: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="mt-4 border-t pt-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Marketplace Account Logins</h4>
        {canAct && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border hover:bg-secondary hover:text-foreground"
          >
            + Add login
          </button>
        )}
      </div>
      {accounts.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground italic">No account created on this marketplace yet.</p>
      )}
      <div className="space-y-2">
        {accounts.map((a) =>
          editing === a.id ? (
            <AccountForm key={a.id} orgId={orgId} account={a} onDone={() => setEditing(null)} />
          ) : (
            <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <a href={`https://${a.host}`} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">
                {a.host}
              </a>
              <span className="inline-flex items-center gap-1.5 text-foreground">
                {a.signup_email ?? "—"}
                {a.signup_email && <CopyButton value={a.signup_email} label="email" />}
              </span>
              <Secret value={a.password} />
              <StatusBadge status={a.status} />
              <OriginBadge account={a} />
              {a.created_by === "ops" && a.created_by_email && (
                <span className="text-[11px] text-muted-foreground">{a.created_by_email}</span>
              )}
              {canAct && (
                <span className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditing(a.id)}
                    className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border hover:bg-secondary hover:text-foreground"
                  >
                    Edit
                  </button>
                  <DeleteButton accountId={a.id} orgId={orgId} />
                </span>
              )}
            </div>
          )
        )}
      </div>
      {adding && (
        <div className="mt-2">
          <AccountForm orgId={orgId} supplierProfileId={supplierProfileId} onDone={() => setAdding(false)} />
        </div>
      )}
    </div>
  );
}

// Org-wide roll-up at the top of the Supplier Validation tab: every login for
// this client, agent-provisioned or ops-entered, including the ones not tied to
// a supplier profile.
export function MarketplaceLogins({
  accounts,
  orgId,
  canAct = false,
  supplierOptions = [],
}: {
  accounts: MarketplaceAccount[];
  orgId?: string;
  canAct?: boolean;
  supplierOptions?: SupplierOption[];
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  if (!accounts.length && !canAct) return null;

  const supplierName = new Map(supplierOptions.map((s) => [s.id, s.name]));
  const active = accounts.filter((a) => a.status === "active").length;
  const verifying = accounts.filter((a) => a.status === "verifying").length;
  const cols = canAct && orgId ? 8 : 7;

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
            {accounts.length} account{accounts.length === 1 ? "" : "s"}
            {active > 0 && <span className="text-emerald-600"> · {active} active</span>}
            {verifying > 0 && <span className="text-amber-600"> · {verifying} awaiting confirm</span>}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3">
          <div className="mb-3 flex items-start justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Accounts used to reach pricing on login-gated marketplaces, whether the agent created them or ops did.
              Where a login shows &quot;Awaiting confirm&quot;, click the confirmation link in the email sent to the
              purchasing inbox to activate it. Credentials are here so ops can log in manually if needed.
            </p>
            {canAct && orgId && !adding && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="shrink-0 rounded px-2 py-1 text-[11px] font-medium text-muted-foreground ring-1 ring-border hover:bg-secondary hover:text-foreground"
              >
                + Add login
              </button>
            )}
          </div>
          {adding && orgId && (
            <div className="mb-3">
              <AccountForm orgId={orgId} supplierOptions={supplierOptions} onDone={() => setAdding(false)} />
            </div>
          )}
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No marketplace logins saved for this client yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Marketplace</th>
                    <th className="py-1.5 pr-3 font-medium">Supplier</th>
                    <th className="py-1.5 pr-3 font-medium">Email</th>
                    <th className="py-1.5 pr-3 font-medium">Password</th>
                    <th className="py-1.5 pr-3 font-medium">Status</th>
                    <th className="py-1.5 pr-3 font-medium">Added by</th>
                    <th className="py-1.5 pr-3 font-medium">Last login</th>
                    {canAct && orgId && <th className="py-1.5 font-medium" />}
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) =>
                    editing === a.id && orgId ? (
                      <tr key={a.id}>
                        <td colSpan={cols} className="py-2">
                          <AccountForm orgId={orgId} account={a} supplierOptions={supplierOptions} onDone={() => setEditing(null)} />
                        </td>
                      </tr>
                    ) : (
                      <tr key={a.id} className="border-b border-border/50 align-top">
                        <td className="py-2 pr-3">
                          <a href={`https://${a.host}`} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground hover:underline">
                            {a.host}
                          </a>
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {(a.supplier_profile_id && supplierName.get(a.supplier_profile_id)) || "—"}
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
                          <StatusBadge status={a.status} />
                          {a.status === "failed" && a.last_error && (
                            <div className="mt-1 max-w-[16rem] text-[11px] text-muted-foreground">{a.last_error}</div>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          <OriginBadge account={a} />
                          {a.created_by === "ops" && a.created_by_email && (
                            <div className="mt-0.5 max-w-[12rem] truncate text-[11px] text-muted-foreground" title={a.created_by_email}>
                              {a.created_by_email}
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-xs text-muted-foreground">
                          {a.last_login_at ? relativeTime(a.last_login_at) : a.verified_at ? `confirmed ${relativeTime(a.verified_at)}` : "—"}
                        </td>
                        {canAct && orgId && (
                          <td className="py-2">
                            <span className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => setEditing(a.id)}
                                className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border hover:bg-secondary hover:text-foreground"
                              >
                                Edit
                              </button>
                              <DeleteButton accountId={a.id} orgId={orgId} />
                            </span>
                          </td>
                        )}
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
