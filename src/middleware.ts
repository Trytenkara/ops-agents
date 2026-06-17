import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function middleware(request: NextRequest) {
  // Stamp the path on a request header so server components can detect the
  // active route without rebroadcasting it through props/context.
  const reqHeaders = new Headers(request.headers);
  reqHeaders.set("x-tackle-path", request.nextUrl.pathname);
  let response = NextResponse.next({ request: { headers: reqHeaders } });

  // API routes own their auth: external-agent bearer (POST /api/agent/*),
  // cron-secret (GET /api/cron), session-cookie-via-getSession (POST /api/agents/*).
  // Skip middleware so they return JSON 401 instead of an HTML redirect to /login.
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return response;
  }

  // Fail-fast on missing env vars so the user sees a clear message instead of MIDDLEWARE_INVOCATION_FAILED.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnon) {
    return new NextResponse(
      `Tackle Box is misconfigured: ${!supabaseUrl ? "NEXT_PUBLIC_SUPABASE_URL" : "NEXT_PUBLIC_SUPABASE_ANON_KEY"} is not set on this deployment. Add it in Vercel → Settings → Environment Variables and redeploy.`,
      { status: 503, headers: { "content-type": "text/plain" } }
    );
  }

  try {
    const supabase = createServerClient(supabaseUrl, supabaseAnon, {
      cookies: {
        get: (name: string) => request.cookies.get(name)?.value,
        set: (name: string, value: string, options: CookieOptions) => {
          response.cookies.set({ name, value, ...options });
        },
        remove: (name: string, options: CookieOptions) => {
          response.cookies.set({ name, value: "", ...options });
        },
      },
    });

    const { data: { user } } = await supabase.auth.getUser();

    const isAuthPage = request.nextUrl.pathname.startsWith("/login") ||
                       request.nextUrl.pathname.startsWith("/signup") ||
                       request.nextUrl.pathname.startsWith("/auth");

    if (!user && !isAuthPage) {
      const redirectUrl = request.nextUrl.clone();
      redirectUrl.pathname = "/login";
      redirectUrl.searchParams.set("next", request.nextUrl.pathname);
      return NextResponse.redirect(redirectUrl);
    }

    if (user && isAuthPage) {
      const url = request.nextUrl.clone();
      url.pathname = "/";
      url.search = "";
      return NextResponse.redirect(url);
    }

    return response;
  } catch (err: any) {
    console.error("middleware error:", err);
    return new NextResponse(
      `Middleware crashed: ${err?.message ?? "unknown error"}. Check Vercel runtime logs.`,
      { status: 500, headers: { "content-type": "text/plain" } }
    );
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
