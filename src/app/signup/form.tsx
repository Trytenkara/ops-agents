"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { selfSignUp } from "@/app/actions/signup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function SignupForm() {
  const params = useSearchParams();
  const next = params.get("next") ?? "/";
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (pw.length < 10) { setMsg("Use at least 10 characters."); return; }
    if (pw !== pw2) { setMsg("Passwords don't match."); return; }
    setLoading(true);

    const res = await selfSignUp({ email, password: pw, displayName });
    if (!res.ok) { setMsg(res.error ?? "Sign-up failed."); setLoading(false); return; }

    // Account created and confirmed server-side — sign straight in.
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password: pw });
    if (error) { setMsg("Account created — head to sign in."); setLoading(false); return; }
    window.location.assign(next);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-serif text-2xl">Create your account</CardTitle>
          <CardDescription>Tenkara sourcing operations. Sign-up is limited to @trytenkara.com email addresses.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <Input type="email" required placeholder="you@trytenkara.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Input type="text" placeholder="Your name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            <Input type="password" required placeholder="Password (10+ chars)" value={pw} onChange={(e) => setPw(e.target.value)} />
            <Input type="password" required placeholder="Confirm password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "..." : "Create account"}
            </Button>
            <a
              href={`/login?next=${encodeURIComponent(next)}`}
              className="text-xs text-muted-foreground hover:underline w-full text-center block"
            >
              Already have an account? Sign in
            </a>
            {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
