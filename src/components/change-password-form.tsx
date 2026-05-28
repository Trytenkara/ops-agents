"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ChangePasswordForm() {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (pw.length < 10) { setMsg({ kind: "error", text: "Use at least 10 characters." }); return; }
    if (pw !== pw2) { setMsg({ kind: "error", text: "Passwords don't match." }); return; }
    setSubmitting(true);
    const { error } = await createClient().auth.updateUser({ password: pw });
    setSubmitting(false);
    if (error) { setMsg({ kind: "error", text: error.message }); return; }
    setPw(""); setPw2("");
    setMsg({ kind: "ok", text: "Password updated. You can use it on the sign-in screen next time." });
  }

  return (
    <form onSubmit={submit} className="space-y-3 max-w-sm">
      <Input type="password" placeholder="New password (10+ chars)" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
      <Input type="password" placeholder="Confirm password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
      <Button type="submit" disabled={submitting}>{submitting ? "Saving..." : "Set password"}</Button>
      {msg && (
        <p className={msg.kind === "error" ? "text-sm text-destructive" : "text-sm text-emerald-700"}>{msg.text}</p>
      )}
    </form>
  );
}
