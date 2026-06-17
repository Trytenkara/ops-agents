"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

// Lands here after the user clicks the invite email magic link. URL typically
// carries either #access_token=... (implicit) or ?token_hash=...&type=invite (PKCE).
// Either way, Supabase Auth's JS client handles the session establishment as the
// page mounts; we just collect a new password and call updateUser.
export default function SetPasswordForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      // 1. PKCE flow: token_hash + type in querystring.
      const tokenHash = params.get("token_hash");
      const type = params.get("type");
      if (tokenHash && (type === "invite" || type === "recovery" || type === "magiclink")) {
        const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as any });
        if (error) { setMsg(error.message); setLoading(false); return; }
      }
      // 2. Implicit flow puts tokens in the URL hash; supabase client picks them up automatically on init.
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setMsg("This invite link is expired or already used. Ask whoever invited you to resend.");
      } else {
        setEmail(user.email ?? null);
      }
      setLoading(false);
    })();
  }, [params]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (pw.length < 10) { setMsg("Use at least 10 characters."); return; }
    if (pw !== pw2) { setMsg("Passwords don't match."); return; }
    setSubmitting(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password: pw });
    setSubmitting(false);
    if (error) { setMsg(error.message); return; }
    setDone(true);
    setTimeout(() => router.push("/work"), 2500);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-background">
      <Card className="w-full max-w-md tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="font-serif text-2xl">Welcome to Control Room</CardTitle>
          <CardDescription>
            {loading ? "Verifying your invite…"
              : email ? <>Set a password for <strong>{email}</strong>.</>
              : "We couldn't validate this invite link."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-2">
              <p className="text-sm">You're in. Two quick notes before you start:</p>
              <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
                <li><strong>Your Work</strong> is your daily inbox — drafts and cases needing a human.</li>
                <li>The <strong>Agents</strong> tab (if you can see it) shows what the robots did.</li>
              </ul>
              <p className="text-xs text-muted-foreground pt-2">Redirecting to your inbox…</p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <Input type="password" placeholder="New password (10+ chars)" value={pw} onChange={(e) => setPw(e.target.value)} disabled={!email} />
              <Input type="password" placeholder="Confirm password" value={pw2} onChange={(e) => setPw2(e.target.value)} disabled={!email} />
              <Button type="submit" className="w-full" disabled={!email || submitting}>
                {submitting ? "..." : "Set password and sign in"}
              </Button>
              {msg && <p className="text-sm text-destructive">{msg}</p>}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
