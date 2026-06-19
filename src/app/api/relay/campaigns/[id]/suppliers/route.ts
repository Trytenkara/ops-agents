import { NextRequest, NextResponse } from "next/server";
import { checkRelayKey, relayUnauthorized } from "@/lib/relay-auth";
import { getCampaignSuppliers } from "@/lib/campaign-suppliers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!checkRelayKey(request)) return relayUnauthorized();
  try {
    const result = await getCampaignSuppliers(params.id);
    if (!result) return NextResponse.json({ error: "campaign not found" }, { status: 404 });

    const group = request.nextUrl.searchParams.get("group");
    if (group) {
      const bucket = (result.groups as Record<string, any[]>)[group];
      if (!bucket) return NextResponse.json({ error: `unknown group '${group}'` }, { status: 400 });
      return NextResponse.json({ campaign_id: result.campaign_id, group, count: bucket.length, suppliers: bucket });
    }
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
