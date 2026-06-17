"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useSearchParams } from "next/navigation";

export default function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") ?? "/";
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [mode, setMode] = useState<"signin" | "magic">("signin");
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setLoading(true);
    const supabase = createClient();
    if (mode === "signin") {
      const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
      if (error) setMsg(error.message);
      else window.location.assign(next);
    } else {
      // Prefer the stable prod URL so magic links don't bake in a preview-deployment
      // origin that later 404s. Fall back to window.location only in local dev.
      const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || window.location.origin;
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${base}/auth/callback?next=${encodeURIComponent(next)}` },
      });
      if (error) setMsg(error.message);
      else setMsg("Check your email for the sign-in link.");
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-serif text-2xl">Control Room</CardTitle>
          <CardDescription>Tenkara sourcing operations. Sign in, or create an account with your @trytenkara.com email.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <Input type="email" required placeholder="you@trytenkara.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            {mode === "signin" && (
              <Input type="password" required placeholder="password" value={pw} onChange={(e) => setPw(e.target.value)} />
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "..." : mode === "signin" ? "Sign in" : "Send magic link"}
            </Button>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:underline w-full text-center"
              onClick={() => setMode(mode === "signin" ? "magic" : "signin")}
            >
              {mode === "signin" ? "Use a magic link instead" : "Use password instead"}
            </button>
            <a
              href={`/signup?next=${encodeURIComponent(next)}`}
              className="text-xs text-muted-foreground hover:underline w-full text-center block"
            >
              Need an account? Sign up
            </a>
            {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
