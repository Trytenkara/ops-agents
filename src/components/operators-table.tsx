"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useRouter } from "next/navigation";
import { OperatorChip } from "@/components/operator-chip";
import { primaryRole } from "@/lib/operator";
import { ROLE_LABELS, roleLabel } from "@/lib/roles";
import type { AppRole } from "@/lib/auth";
import { inviteOperator, resendInvite, changeUserRole, setOrgAssignments, deactivateUser, reactivateUser } from "@/app/actions/operators";
import { relativeTime } from "@/lib/utils";
import { orgDisplayName } from "@/lib/org-display";

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  status: "active" | "out_of_office";
  invited_at: string | null;
  last_login_at: string | null;
  deactivated_at: string | null;
  user_roles: { role: string }[];
  user_org_assignments: { orgs: { slug: string; name: string; display_name: string | null } }[];
}

interface Org {
  id: string;
  slug: string;
  name: string;
  display_name: string | null;
  is_internal: boolean;
}

interface Actor {
  id: string;
  roles: AppRole[];
}

function pickStatus(u: UserRow): "active" | "pending" | "inactive" {
  if (u.deactivated_at) return "inactive";
  if (!u.last_login_at && u.invited_at) return "pending";
  return "active";
}

function invitableRoles(actor: Actor): AppRole[] {
  if (actor.roles.includes("admin")) {
    return ["admin", "ops_lead", "ops_operator", "account_manager", "monitor"];
  }
  if (actor.roles.includes("ops_lead")) {
    return ["ops_operator", "account_manager"];
  }
  return [];
}

export function OperatorsTable({ actor, users, orgs }: { actor: Actor; users: UserRow[]; orgs: Org[] }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);

  const activeUsers = users.filter((u) => pickStatus(u) !== "inactive");
  const deactivatedUsers = users.filter((u) => pickStatus(u) === "inactive");

  function renderRow(u: UserRow) {
    const role = primaryRole(u.user_roles.map((r) => r.role));
    const status = pickStatus(u);
    return (
      <TableRow key={u.id}>
        <TableCell>
          <OperatorChip name={u.display_name} email={u.email} role={role} />
        </TableCell>
        <TableCell>{role ? roleLabel(role) : "—"}</TableCell>
        <TableCell className="text-muted-foreground text-xs">
          {u.user_org_assignments.length === 0 ? (
            u.user_roles.some((r) => r.role === "admin" || r.role === "monitor")
              ? <span title="Admins and Monitors have global access">all orgs</span>
              : "—"
          ) : (
            u.user_org_assignments.map((a) => a.orgs && orgDisplayName(a.orgs)).filter(Boolean).join(", ")
          )}
        </TableCell>
        <TableCell><StatusBadge s={status} /></TableCell>
        <TableCell className="text-muted-foreground text-xs">
          {u.last_login_at ? relativeTime(u.last_login_at) : (u.invited_at ? `invited ${relativeTime(u.invited_at)}` : "—")}
        </TableCell>
        <TableCell className="text-right">
          <button onClick={() => setEditing(u)} className="text-primary hover:underline text-sm">Manage</button>
        </TableCell>
      </TableRow>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex justify-end">
          {invitableRoles(actor).length > 0 && (
            <Button onClick={() => setOpen(true)}>Invite operator</Button>
          )}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Orgs</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last login</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {activeUsers.map(renderRow)}
            {activeUsers.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No operators yet.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {deactivatedUsers.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs uppercase tracking-wider text-muted-foreground font-medium">Deactivated ({deactivatedUsers.length})</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Orgs</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last login</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deactivatedUsers.map(renderRow)}
            </TableBody>
          </Table>
        </div>
      )}

      {open && <InviteModal onClose={() => setOpen(false)} actor={actor} orgs={orgs} />}
      {editing && <ManageModal user={editing} actor={actor} orgs={orgs} onClose={() => setEditing(null)} />}
    </div>
  );
}

function StatusBadge({ s }: { s: "active" | "pending" | "inactive" }) {
  if (s === "active") return <Badge variant="success">Active</Badge>;
  if (s === "pending") return <Badge variant="warn">Pending</Badge>;
  return <Badge variant="secondary">Inactive</Badge>;
}

function InviteModal({ onClose, actor, orgs }: { onClose: () => void; actor: Actor; orgs: Org[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AppRole>(invitableRoles(actor)[0]);
  const [selectedOrgs, setSelectedOrgs] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    start(async () => {
      const res = await inviteOperator({
        email, displayName: name, role, orgIds: Array.from(selectedOrgs),
      });
      if (!res.ok) setMsg(res.error ?? "failed");
      else { router.refresh(); onClose(); }
    });
  }

  return (
    <Modal title="Invite operator" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Email">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="rosie@trytenkara.com" />
        </Field>
        <Field label="Display name (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rosie Mendoza" />
        </Field>
        <Field label="Role">
          <Select
            ariaLabel="Role"
            value={role}
            onValueChange={(v) => setRole(v as AppRole)}
            options={invitableRoles(actor).map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          />
        </Field>
        <Field label={`Org assignments (${selectedOrgs.size})`}>
          <div className="border border-border rounded-md p-2 max-h-48 overflow-y-auto space-y-1">
            {orgs.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-sm hover:bg-secondary/40 px-2 py-1 rounded">
                <input
                  type="checkbox"
                  checked={selectedOrgs.has(o.id)}
                  onChange={() => {
                    const next = new Set(selectedOrgs);
                    next.has(o.id) ? next.delete(o.id) : next.add(o.id);
                    setSelectedOrgs(next);
                  }}
                />
                <span className={o.is_internal ? "text-muted-foreground" : ""}>{orgDisplayName(o)}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Admins and Monitors get global access automatically. Operators and Account Managers need explicit org assignments.
          </p>
        </Field>
        {msg && <p className="text-sm text-destructive">{msg}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending}>{pending ? "Sending invite..." : "Send invite"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ManageModal({ user, actor, orgs, onClose }: { user: UserRow; actor: Actor; orgs: Org[]; onClose: () => void }) {
  const router = useRouter();
  const [role, setRole] = useState<AppRole>(primaryRole(user.user_roles.map((r) => r.role)) ?? "ops_operator");
  const [selectedOrgs, setSelectedOrgs] = useState<Set<string>>(
    new Set(user.user_org_assignments.map((a) => orgs.find((o) => o.slug === a.orgs.slug)?.id).filter(Boolean) as string[])
  );
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const status = pickStatus(user);
  const isSelf = user.id === actor.id;

  function save() {
    setMsg(null);
    start(async () => {
      const roleRes = await changeUserRole(user.id, role);
      if (!roleRes.ok) { setMsg(roleRes.error ?? "role change failed"); return; }
      const orgRes = await setOrgAssignments(user.id, Array.from(selectedOrgs));
      if (!orgRes.ok) { setMsg(orgRes.error ?? "org assignment failed"); return; }
      router.refresh();
      onClose();
    });
  }
  function doResend() { start(async () => { const r = await resendInvite(user.id); if (r.ok) { router.refresh(); onClose(); } else setMsg(r.error ?? "failed"); }); }
  function doDeactivate() { start(async () => { const r = await deactivateUser(user.id); if (r.ok) { router.refresh(); onClose(); } else setMsg(r.error ?? "failed"); }); }
  function doReactivate() { start(async () => { const r = await reactivateUser(user.id); if (r.ok) { router.refresh(); onClose(); } else setMsg(r.error ?? "failed"); }); }

  return (
    <Modal title={user.display_name ?? user.email} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-sm text-muted-foreground">{user.email}</div>

        <Field label="Role">
          <Select
            ariaLabel="Role"
            value={role}
            onValueChange={(v) => setRole(v as AppRole)}
            disabled={isSelf}
            options={invitableRoles(actor).map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          />
          {isSelf && <p className="text-xs text-muted-foreground mt-1">You can't change your own role.</p>}
        </Field>

        <Field label={`Org assignments (${selectedOrgs.size})`}>
          <div className="border border-border rounded-md p-2 max-h-48 overflow-y-auto space-y-1">
            {orgs.map((o) => (
              <label key={o.id} className="flex items-center gap-2 text-sm hover:bg-secondary/40 px-2 py-1 rounded">
                <input
                  type="checkbox"
                  checked={selectedOrgs.has(o.id)}
                  onChange={() => {
                    const next = new Set(selectedOrgs);
                    next.has(o.id) ? next.delete(o.id) : next.add(o.id);
                    setSelectedOrgs(next);
                  }}
                />
                <span className={o.is_internal ? "text-muted-foreground" : ""}>{orgDisplayName(o)}</span>
              </label>
            ))}
          </div>
        </Field>

        {msg && <p className="text-sm text-destructive">{msg}</p>}

        <div className="flex flex-wrap justify-between gap-2 pt-2 border-t border-border">
          <div className="flex gap-2">
            {status === "pending" && <Button variant="outline" disabled={pending} onClick={doResend}>Resend invite</Button>}
            {status !== "inactive" && !isSelf && (
              <Button variant="destructive" disabled={pending} onClick={doDeactivate}>Deactivate</Button>
            )}
            {status === "inactive" && actor.roles.includes("admin") && (
              <Button variant="outline" disabled={pending} onClick={doReactivate}>Reactivate</Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button disabled={pending} onClick={save}>{pending ? "Saving..." : "Save"}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5 block font-medium">{label}</label>
      {children}
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-foreground/30 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg shadow-lg max-w-md w-full p-6 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-serif text-xl">{title}</h2>
        {children}
      </div>
    </div>
  );
}
