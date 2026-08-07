import { NextResponse, type NextRequest } from "next/server";
import { openSession, browserbaseConfigured } from "@/lib/browserbase-session";

export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!browserbaseConfigured()) {
    return NextResponse.json({ ok: false, error: "browserbase env not set on this deployment" }, { status: 500 });
  }
  const url = new URL(request.url).searchParams.get("url") || "https://example.com";
  const t0 = Date.now();
  let s;
  try {
    s = await openSession();
    const res = await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const title = await s.page.title();
    const bodyLen = (await s.page.evaluate(() => document.body?.innerText?.length ?? 0)) as number;
    return NextResponse.json({
      ok: true,
      sessionId: s.sessionId,
      viewUrl: s.viewUrl,
      status: res?.status() ?? null,
      title,
      bodyLen,
      ms: Date.now() - t0,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e), ms: Date.now() - t0 }, { status: 500 });
  } finally {
    await s?.browser.close().catch(() => {});
  }
}
