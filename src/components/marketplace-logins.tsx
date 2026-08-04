"use client";

import { useState, useTransition } from "react";
import { Select } from "@/components/ui/select";
import { cn, relativeTime } from "@/lib/utils";
import { assignMarketplaceAccount } from "@/app/actions/marketplace-accounts";

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
  gate_reason?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  contact_url?: string | null;
  contact_notes?: string | null;
};

// One login as the validation form edits it. Mirrors a marketplace_accounts row;
// rows without an id have not been saved yet.
export type AccountDraft = {
  key: string;
  id?: string;
  host: string;
  signupEmail: string;
  password: string;
  status: string;
  createdBy: string | null;
  createdByEmail: string | null;
  lastError: string | null;
  lastLoginAt: string | null;
  verifiedAt: string | null;
  gateReason: string | null;
  contact: GateContact | null;
};

// Who to ask when a marketplace only opens accounts by hand.
export type GateContact = {
  name: string | null;
  email: string | null;
  phone: string | null;
  url: string | null;
  notes: string | null;
};

function gateContactOf(a: MarketplaceAccount): GateContact | null {
  if (!(a.contact_email || a.contact_phone || a.contact_url)) return null;
  return {
    name: a.contact_name ?? null,
    email: a.contact_email ?? null,
    phone: a.contact_phone ?? null,
    url: a.contact_url ?? null,
    notes: a.contact_notes ?? null,
  };
}

export function toAccountDrafts(accounts: MarketplaceAccount[]): AccountDraft[] {
  return accounts.map((a) => ({
    key: a.id,
    id: a.id,
    host: a.host,
    signupEmail: a.signup_email ?? "",
    password: a.password ?? "",
    status: a.status,
    createdBy: a.created_by,
    createdByEmail: a.created_by_email,
    lastError: a.last_error,
    lastLoginAt: a.last_login_at,
    verifiedAt: a.verified_at,
    gateReason: a.gate_reason ?? null,
    contact: gateContactOf(a),
  }));
}

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

// Why self-serve signup could not finish (marketplace_accounts.gate_reason).
// "Failed" alone tells an operator nothing they can act on; the gate says whether
// to retry, wait, or go ask a person, which is a different job each time.
const GATE: Record<string, { label: string; hint: string }> = {
  invite_only: { label: "Invite only", hint: "The store publishes no registration route at all. An account has to be granted from their side." },
  application_only: { label: "Application only", hint: "Self-serve signup is disabled. The account is opened by application, usually by phone or email." },
  email_confirm_required: { label: "Needs email confirm", hint: "Registration went through, but the login stays refused until a link in the confirmation email is clicked." },
  pending_approval: { label: "Awaiting their approval", hint: "The account exists and is confirmed. The marketplace reviews B2B buyers by hand and has not approved it yet." },
  captcha_wall: { label: "Captcha wall", hint: "A captcha the agent cannot solve stands in front of signup and login." },
  already_registered: { label: "Address already taken", hint: "The email is already registered on this store. Needs a password reset by hand." },
  needs_client_data: { label: "Missing client data", hint: "The form requires a detail the client's own records do not hold (usually a phone number). Fill it in client settings and re-run." },
  no_signup_form: { label: "No signup form found", hint: "No registration form at any known path. Paste the store's register URL and the agent can retry." },
  login_rejected: { label: "Credentials refused", hint: "The store rejected the saved credentials for an unstated reason." },
  not_needed: { label: "No login needed", hint: "This store's prices are public. The login flag was a false positive, nothing to do." },
  unclassified: { label: "Unclassified", hint: "The run could not diagnose what stopped it. Inspect the session recording." },
};

function GateBadge({ gate }: { gate: string }) {
  const g = GATE[gate];
  const neutral = gate === "not_needed";
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
        neutral ? "bg-slate-500/15 text-slate-500 ring-slate-500/30" : "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300"
      )}
      title={g?.hint ?? gate}
    >
      {g?.label ?? gate}
    </span>
  );
}

// The way past a human gate: mailto / tel / the store's own application page.
function GateContactLine({ contact }: { contact: GateContact }) {
  return (
    <span className="w-full text-[11px] text-muted-foreground">
      Ask for access:{" "}
      {contact.name && <span className="text-foreground">{contact.name} </span>}
      {contact.email && (
        <>
          <a href={`mailto:${contact.email}`} className="text-foreground hover:underline">
            {contact.email}
          </a>{" "}
        </>
      )}
      {contact.phone && <span className="text-foreground">{contact.phone} </span>}
      {contact.url && (
        <a href={contact.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
          (application page)
        </a>
      )}
      {contact.notes && <span className="block">{contact.notes}</span>}
    </span>
  );
}

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
function OriginBadge({ createdBy, createdByEmail }: { createdBy: string | null; createdByEmail: string | null }) {
  const byOps = createdBy === "ops";
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ring-1",
        byOps ? "bg-violet-500/15 text-violet-600 ring-violet-500/30" : "bg-sky-500/15 text-sky-600 ring-sky-500/30"
      )}
      title={byOps ? `Added by ${createdByEmail ?? "an ops operator"}` : "Auto-created by the price-pull agent"}
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
  "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

let draftSeq = 0;

// Marketplace access as a step of supplier validation: the logins live in the
// profile form and are saved by the card's own Edit → Save, not a side panel.
export function MarketplaceAccessFields({
  rows,
  editing,
  defaultHost,
  onChange,
}: {
  rows: AccountDraft[];
  editing: boolean;
  defaultHost: string;
  onChange: (rows: AccountDraft[]) => void;
}) {
  function patch(key: string, field: keyof AccountDraft, value: string) {
    onChange(rows.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  return (
    <div className="mt-4 border-t pt-3">
      <div className="mb-2 flex items-baseline gap-2">
        <h4 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground">Marketplace Access</h4>
        <span className="text-[11px] text-muted-foreground">
          Account used to see this marketplace&apos;s gated pricing. Add one per login the team holds.
        </span>
      </div>

      {!editing && rows.length === 0 && (
        <p className="text-sm text-muted-foreground italic">
          No account on this marketplace yet{" "}
          <span className="not-italic">— use Edit to record the email and password of one.</span>
        </p>
      )}

      {!editing && rows.length > 0 && (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <a href={`https://${r.host}`} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">
                {r.host}
              </a>
              <span className="inline-flex items-center gap-1.5 text-foreground">
                {r.signupEmail || "—"}
                {r.signupEmail && <CopyButton value={r.signupEmail} label="email" />}
              </span>
              <Secret value={r.password} />
              <StatusBadge status={r.status} />
              {r.gateReason && <GateBadge gate={r.gateReason} />}
              <OriginBadge createdBy={r.createdBy} createdByEmail={r.createdByEmail} />
              {r.createdBy === "ops" && r.createdByEmail && (
                <span className="text-[11px] text-muted-foreground">{r.createdByEmail}</span>
              )}
              <span className="text-[11px] text-muted-foreground">
                {r.lastLoginAt
                  ? `last login ${relativeTime(r.lastLoginAt)}`
                  : r.verifiedAt
                    ? `confirmed ${relativeTime(r.verifiedAt)}`
                    : ""}
              </span>
              {r.contact && <GateContactLine contact={r.contact} />}
              {r.status === "failed" && r.lastError && (
                <span className="w-full text-[11px] text-muted-foreground">{r.lastError}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.key} className="grid grid-cols-1 items-end gap-2 md:grid-cols-[1fr_1.4fr_1fr_1fr_auto]">
              <label className="space-y-0.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Site</span>
                <input className={inputCls} value={r.host} onChange={(e) => patch(r.key, "host", e.target.value)} placeholder="knowde.com" />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Account email</span>
                <input className={inputCls} value={r.signupEmail} onChange={(e) => patch(r.key, "signupEmail", e.target.value)} placeholder="purchasing@client.com" />
              </label>
              <label className="space-y-0.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Password</span>
                <input className={inputCls} value={r.password} onChange={(e) => patch(r.key, "password", e.target.value)} placeholder="account password" />
              </label>
              <div className="space-y-0.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Status</span>
                <Select
                  size="sm"
                  ariaLabel="Login status"
                  value={r.status}
                  onValueChange={(v) => patch(r.key, "status", v)}
                  options={
                    OPS_STATUS_OPTIONS.some((o) => o.value === r.status)
                      ? OPS_STATUS_OPTIONS
                      : [...OPS_STATUS_OPTIONS, { value: r.status, label: STATUS[r.status]?.label ?? r.status }]
                  }
                />
              </div>
              <div className="flex items-center gap-2 pb-0.5">
                <OriginBadge createdBy={r.createdBy} createdByEmail={r.createdByEmail} />
                <button
                  type="button"
                  onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border hover:bg-secondary hover:text-destructive"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              onChange([
                ...rows,
                {
                  key: `new-${draftSeq++}`,
                  host: defaultHost,
                  signupEmail: "",
                  password: "",
                  status: "active",
                  createdBy: "ops",
                  createdByEmail: null,
                  lastError: null,
                  lastLoginAt: null,
                  verifiedAt: null,
                  gateReason: null,
                  contact: null,
                },
              ])
            }
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border hover:bg-secondary hover:text-foreground"
          >
            + Add login
          </button>
        </div>
      )}
    </div>
  );
}

// Exception strip: agent-provisioned logins whose host matched no supplier in
// this client's list, so their credentials aren't stranded off-screen. Absent
// once every login sits on a supplier.
export function UnlinkedMarketplaceLogins({
  accounts,
  orgId,
  canAct,
  supplierOptions,
}: {
  accounts: MarketplaceAccount[];
  orgId: string;
  canAct: boolean;
  supplierOptions: { id: string; name: string }[];
}) {
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<Record<string, string>>({});
  if (!accounts.length) return null;

  return (
    <div className="rounded-lg border border-amber-300/60 bg-amber-500/10 px-4 py-3 space-y-2">
      <div className="text-xs uppercase tracking-wider font-semibold text-amber-800 dark:text-amber-300">
        {accounts.length} marketplace login{accounts.length === 1 ? "" : "s"} not matched to a supplier
      </div>
      <p className="text-xs text-muted-foreground">
        The agent created these to reach gated pricing, but their site doesn&apos;t match any supplier below. Pick the
        supplier each belongs to and it moves onto that supplier&apos;s validation card.
      </p>
      {accounts.map((a) => (
        <div key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <a href={`https://${a.host}`} target="_blank" rel="noopener noreferrer" className="font-medium hover:underline">
            {a.host}
          </a>
          <span className="text-foreground">{a.signup_email ?? "—"}</span>
          <Secret value={a.password} />
          <StatusBadge status={a.status} />
          {a.gate_reason && <GateBadge gate={a.gate_reason} />}
          {canAct && (
            <span className="inline-flex items-center gap-1.5">
              <Select
                size="sm"
                className="min-w-[14rem]"
                ariaLabel="Assign to supplier"
                placeholder="Assign to supplier..."
                value={choice[a.id] ?? ""}
                onValueChange={(v) => setChoice((c) => ({ ...c, [a.id]: v }))}
                options={supplierOptions.map((s) => ({ value: s.id, label: s.name }))}
              />
              <button
                type="button"
                disabled={pending || !choice[a.id]}
                onClick={() => startTransition(async () => { await assignMarketplaceAccount(a.id, orgId, choice[a.id]); })}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border hover:bg-secondary hover:text-foreground disabled:opacity-40"
              >
                Assign
              </button>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
