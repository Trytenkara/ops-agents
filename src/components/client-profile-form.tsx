"use client";
import { useState, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  saveClientSettings,
  generateClientProfileAction,
  editClientProfile,
  addClientNote,
  uploadClientFile,
  type ClientSettingsInput,
} from "@/app/actions/client-settings";

export interface ProfileValue {
  client_type: "active" | "ghost" | "skip" | "prospect" | null;
  summary: string | null;
  highlights: string[];
  sources: { title: string; url: string }[];
  rep_sheet: Record<string, string | null>;
  last_generated_at: string | null;
  manual_override: boolean;
}

// The supplier questions operators must be able to answer for a client.
const REP_FIELDS: { key: string; label: string }[] = [
  { key: "years_in_business", label: "Years in business" },
  { key: "products", label: "Company / products" },
  { key: "address", label: "Address" },
  { key: "end_use", label: "End use of material" },
  { key: "volume", label: "Volume needed (monthly/annual)" },
  { key: "order_timing", label: "Order timing" },
  { key: "intended_use", label: "Intended use (resale/distribution vs manufacturing)" },
  { key: "can_meet_in_person", label: "Can meet in person" },
];
export interface SettingsValue extends ClientSettingsInput {}
export interface UploadItem { id: string; kind: string; file_name: string | null; content_text: string | null; created_at: string }

const MODE_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "ghost", label: "Ghost" },
  { value: "skip", label: "Skip" },
];
const TIER_OPTIONS = [
  { value: "standard", label: "Standard" },
  { value: "priority", label: "Priority" },
  { value: "vip", label: "VIP" },
];
const TYPE_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "ghost", label: "Ghost" },
  { value: "skip", label: "Skip" },
  { value: "prospect", label: "Prospect" },
];
const TYPE_VARIANT: Record<string, "success" | "secondary" | "warn" | "outline"> = {
  active: "success", ghost: "warn", skip: "secondary", prospect: "outline",
};

export function ClientProfilePanel({
  orgId,
  profile,
  settings,
  uploads,
  canEdit,
}: {
  orgId: string;
  profile: ProfileValue | null;
  settings: SettingsValue | null;
  uploads: UploadItem[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) {
    setMsg(null);
    start(async () => {
      const res = await fn();
      if (res.ok) { setMsg({ kind: "ok", text: okText }); router.refresh(); }
      else setMsg({ kind: "err", text: res.error ?? "Something went wrong" });
    });
  }

  return (
    <div className="space-y-6">
      <ProfileCard orgId={orgId} profile={profile} canEdit={canEdit} pending={pending} run={run} />
      <RepSheetCard orgId={orgId} profile={profile} canEdit={canEdit} pending={pending} run={run} />
      <UploadsCard orgId={orgId} uploads={uploads} canEdit={canEdit} pending={pending} run={run} />
      <SettingsCard orgId={orgId} settings={settings} canEdit={canEdit} pending={pending} run={run} />
      {msg && <p className={msg.kind === "ok" ? "text-sm text-emerald-700" : "text-sm text-red-700"}>{msg.text}</p>}
    </div>
  );
}

type RunFn = (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => void;

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm uppercase tracking-wider text-muted-foreground font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function RepSheetCard({ orgId, profile, canEdit, pending, run }: { orgId: string; profile: ProfileValue | null; canEdit: boolean; pending: boolean; run: RunFn }) {
  const sheet = profile?.rep_sheet ?? {};
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(REP_FIELDS.map((f) => [f.key, sheet[f.key] ?? ""]))
  );

  return (
    <Section
      title="Supplier rep sheet"
      action={canEdit && profile && (
        editing
          ? <div className="flex gap-2">
              <Button size="sm" disabled={pending} onClick={() => {
                const cleaned = Object.fromEntries(REP_FIELDS.map((f) => [f.key, draft[f.key]?.trim() ? draft[f.key].trim() : null]));
                run(() => editClientProfile(orgId, { rep_sheet: cleaned }), "Rep sheet saved."); setEditing(false);
              }}>Save</Button>
              <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          : <Button size="sm" variant="secondary" disabled={pending} onClick={() => {
              setDraft(Object.fromEntries(REP_FIELDS.map((f) => [f.key, sheet[f.key] ?? ""])));
              setEditing(true);
            }}>Edit</Button>
      )}
    >
      <p className="text-xs text-muted-foreground -mt-1">The questions suppliers ask about a client. Agent 12 fills what it can; complete the rest.</p>
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {REP_FIELDS.map((f) => (
          <div key={f.key} className="flex flex-col">
            <dt className="text-xs uppercase tracking-wider text-muted-foreground">{f.label}</dt>
            {editing ? (
              <Input value={draft[f.key]} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} placeholder="—" />
            ) : (
              <dd className={sheet[f.key] ? "" : "text-muted-foreground italic"}>{sheet[f.key] || "— needs ops input"}</dd>
            )}
          </div>
        ))}
      </dl>
    </Section>
  );
}

function ProfileCard({ orgId, profile, canEdit, pending, run }: { orgId: string; profile: ProfileValue | null; canEdit: boolean; pending: boolean; run: RunFn }) {
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(profile?.summary ?? "");
  const [type, setType] = useState(profile?.client_type ?? "prospect");

  const generated = !!profile?.last_generated_at;
  return (
    <Section
      title="Client profile"
      action={
        <div className="flex items-center gap-2">
          {profile?.client_type && <Badge variant={TYPE_VARIANT[profile.client_type] ?? "secondary"}>{profile.client_type}</Badge>}
          {profile?.manual_override && <Badge variant="outline">edited</Badge>}
          {canEdit && (
            <Button size="sm" variant="secondary" disabled={pending}
              onClick={() => run(() => generateClientProfileAction(orgId, generated), generated ? "Re-researching…" : "Researching…")}>
              {generated ? "Regenerate" : "Generate"}
            </Button>
          )}
        </div>
      }
    >
      {!profile || !generated ? (
        <p className="text-sm text-muted-foreground">No profile yet. Click Generate to research this client (web + Tenkara + uploads).</p>
      ) : editing ? (
        <div className="space-y-2">
          <Select value={type} onValueChange={(v) => setType(v as any)} options={TYPE_OPTIONS} ariaLabel="Client type" />
          <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={8}
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          <div className="flex gap-2">
            <Button size="sm" disabled={pending} onClick={() => { run(() => editClientProfile(orgId, { summary, client_type: type as any }), "Saved your edits."); setEditing(false); }}>Save edits</Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="whitespace-pre-wrap leading-relaxed">{profile.summary}</p>
          {profile.highlights.length > 0 && (
            <ul className="list-disc pl-5 space-y-0.5">
              {profile.highlights.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          )}
          {profile.sources.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Sources:{" "}
              {profile.sources.map((s, i) => (
                <a key={i} href={s.url} target="_blank" rel="noreferrer" className="underline mr-2">{s.title}</a>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3 pt-1">
            <span className="text-xs text-muted-foreground">Generated {new Date(profile.last_generated_at!).toLocaleString()}</span>
            {canEdit && <button className="text-xs underline" onClick={() => { setSummary(profile.summary ?? ""); setType(profile.client_type ?? "prospect"); setEditing(true); }}>Edit</button>}
          </div>
        </div>
      )}
    </Section>
  );
}

function UploadsCard({ orgId, uploads, canEdit, pending, run }: { orgId: string; uploads: UploadItem[]; canEdit: boolean; pending: boolean; run: RunFn }) {
  const [note, setNote] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <Section title="Uploaded info">
      {uploads.length > 0 ? (
        <ul className="text-sm space-y-1">
          {uploads.map((u) => (
            <li key={u.id} className="flex items-center gap-2">
              <Badge variant="secondary">{u.kind}</Badge>
              <span className="truncate">{u.file_name ?? (u.content_text ?? "").slice(0, 80)}</span>
              <span className="text-xs text-muted-foreground ml-auto">{new Date(u.created_at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing uploaded yet.</p>
      )}
      {canEdit && (
        <div className="space-y-2 pt-1">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Paste a note about this client…"
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" disabled={pending || !note.trim()}
              onClick={() => run(async () => { const r = await addClientNote(orgId, note); if (r.ok) setNote(""); return r; }, "Note added — profile updated.")}>Add note</Button>
            <input ref={fileRef} type="file" className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]; if (!f) return;
                const fd = new FormData(); fd.set("file", f);
                run(() => uploadClientFile(orgId, fd), "File uploaded — profile updated.");
                if (fileRef.current) fileRef.current.value = "";
              }} />
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => fileRef.current?.click()}>Upload file</Button>
            <span className="text-xs text-muted-foreground">text/markdown/csv extracted; other types stored</span>
          </div>
        </div>
      )}
    </Section>
  );
}

function SettingsCard({ orgId, settings, canEdit, pending, run }: { orgId: string; settings: SettingsValue | null; canEdit: boolean; pending: boolean; run: RunFn }) {
  const [mode, setMode] = useState<ClientSettingsInput["outreach_mode"]>(settings?.outreach_mode ?? "active");
  const [ghostBrand, setGhostBrand] = useState(settings?.ghost_brand ?? "");
  // Priority tier is no longer ops-facing; preserve whatever's stored on save.
  const tier: ClientSettingsInput["priority_tier"] = settings?.priority_tier ?? "standard";
  const [contactName, setContactName] = useState(settings?.primary_contact_name ?? "");
  const [contactEmail, setContactEmail] = useState(settings?.primary_contact_email ?? "");
  const [notes, setNotes] = useState(settings?.sourcing_notes ?? "");

  function collect(): ClientSettingsInput {
    return {
      outreach_mode: mode,
      ghost_brand: mode === "ghost" ? ghostBrand : null,
      priority_tier: tier,
      primary_contact_name: contactName,
      primary_contact_email: contactEmail,
      sourcing_notes: notes,
    };
  }

  return (
    <Section title="Client settings (optional inputs)">
      <p className="text-xs text-muted-foreground -mt-1">Anything you enter here feeds the next profile generation.</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Priority contact"><Input value={contactName} onChange={(e) => setContactName(e.target.value)} disabled={!canEdit || pending} placeholder="—" /></Field>
        <Field label="Purchasing email"><Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} disabled={!canEdit || pending} placeholder="—" /></Field>
        <Field label="Outreach mode"><Select value={mode} onValueChange={(v) => setMode(v as any)} options={MODE_OPTIONS} disabled={!canEdit || pending} ariaLabel="Outreach mode" /></Field>
        {mode === "ghost" && <Field label="Ghost brand"><Input value={ghostBrand} onChange={(e) => setGhostBrand(e.target.value)} disabled={!canEdit || pending} /></Field>}
      </div>
      <Field label="Sourcing notes">
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canEdit || pending} rows={2}
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50" />
      </Field>
      {canEdit && <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => saveClientSettings(orgId, collect()), "Settings saved.")}>Save settings</Button>}
    </Section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">{label}</span>
      {children}
    </label>
  );
}
