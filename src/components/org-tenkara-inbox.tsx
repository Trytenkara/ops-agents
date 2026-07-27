"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { setOrgTenkaraInbox } from "@/app/actions/client-settings";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function OrgTenkaraInbox({
  orgId,
  orgName,
  initialAccountId,
  initialEmail,
  canEdit,
}: {
  orgId: string;
  orgName: string;
  initialAccountId: string | null;
  initialEmail: string | null;
  canEdit: boolean;
}) {
  const [savedAccountId, setSavedAccountId] = useState(initialAccountId ?? "");
  const [accountId, setAccountId] = useState(initialAccountId ?? "");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [savedEmail, setSavedEmail] = useState(initialEmail ?? "");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();

  const trimmedId = accountId.trim();
  const idValid = trimmedId === "" || UUID_RE.test(trimmedId);
  const connected = savedAccountId.trim() !== "";
  const dirty = accountId.trim() !== savedAccountId.trim() || email.trim() !== savedEmail.trim();

  function save() {
    setMsg(null);
    start(async () => {
      const res = await setOrgTenkaraInbox(orgId, accountId, email);
      if (!res.ok) {
        setMsg(res.error ?? "failed");
      } else {
        setSavedAccountId(accountId.trim());
        setSavedEmail(email.trim());
        setMsg("Saved");
        router.refresh();
      }
    });
  }

  if (!canEdit) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <Badge variant={connected ? "default" : "outline"}>{connected ? "Email connected" : "No email"}</Badge>
        {connected && savedEmail && <span className="text-muted-foreground">{savedEmail}</span>}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant={connected ? "default" : "outline"}>{connected ? "Email connected" : "No email"}</Badge>
        <span className="text-muted-foreground">
          Paste this client&apos;s Tenkara Inbox to send outreach from their mailbox.
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 max-w-2xl">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Sending address (display)</span>
          <Input
            type="email"
            value={email}
            placeholder="purchasing@client.com"
            onChange={(e) => setEmail(e.target.value)}
            aria-label={`Sending address for ${orgName}`}
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Tenkara Inbox account ID (UUID)</span>
          <Input
            value={accountId}
            placeholder="00000000-0000-0000-0000-000000000000"
            onChange={(e) => setAccountId(e.target.value)}
            aria-label={`Tenkara inbox account ID for ${orgName}`}
            className={!idValid ? "border-destructive" : undefined}
          />
        </label>
      </div>
      {!idValid && <p className="text-xs text-destructive">Account ID must be a UUID from the Tenkara Inbox app.</p>}
      <div className="flex items-center gap-3">
        {dirty && (
          <Button size="sm" disabled={pending || !idValid} onClick={save}>
            {pending ? "Saving..." : "Save"}
          </Button>
        )}
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
      <p className="text-xs text-muted-foreground">
        Once an inbox is set and Sourcing is <span className="font-medium">Active</span>, the fleet sends this client&apos;s
        outreach automatically — no deploy needed.
      </p>
    </div>
  );
}
