import { NextRequest, NextResponse } from "next/server";
import { checkRelayKey, relayUnauthorized } from "@/lib/relay-auth";
import { listCampaigns, resolveSource } from "@/lib/campaign-suppliers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!checkRelayKey(request)) return relayUnauthorized();
  const source = resolveSource(request.nextUrl.searchParams.get("source"));
  const orgId = request.nextUrl.searchParams.get("org_id") ?? undefined;
  try {
    const campaigns = await listCampaigns(source, orgId);
    return NextResponse.json({ source, count: campaigns.length, campaigns });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
