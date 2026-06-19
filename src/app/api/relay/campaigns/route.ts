import { NextRequest, NextResponse } from "next/server";
import { checkRelayKey, relayUnauthorized } from "@/lib/relay-auth";
import { listCampaigns } from "@/lib/campaign-suppliers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!checkRelayKey(request)) return relayUnauthorized();
  const orgId = request.nextUrl.searchParams.get("org_id") ?? undefined;
  try {
    const campaigns = await listCampaigns(orgId);
    return NextResponse.json({ count: campaigns.length, campaigns });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
