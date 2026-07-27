import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

// Landing route for email sign-in links (magic link, invite, recovery). Supabase
// delivers the credential in one of three shapes depending on the email template
// and client flow:
//   - ?code=...                    PKCE (exchangeCodeForSession)
//   - ?token_hash=...&type=...     token-hash template (verifyOtp)  ← what our templates use
//   - #access_token=...            implicit flow (hash is client-only, handled on /login)
// We handle the first two here; the hash variant can't be read server-side, so the
// login page consumes it client-side. On failure we bounce to /login with the error
// visible instead of silently dropping the user back on the password form.
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = url.searchParams.get("next") ?? "/";

  const supabase = createClient();
  let errorMessage: string | null = null;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    errorMessage = error?.message ?? null;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    errorMessage = error?.message ?? null;
  }
  // No recognized credential in the querystring: likely an implicit-flow (#hash)
  // link. Fall through to `next`; the login page's client picks up the hash and
  // redirects on. If that path is protected, middleware sends it to /login where
  // the hash is consumed.

  if (errorMessage) {
    const login = new URL("/login", url.origin);
    login.searchParams.set("next", next);
    login.searchParams.set("error", errorMessage);
    return NextResponse.redirect(login);
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
