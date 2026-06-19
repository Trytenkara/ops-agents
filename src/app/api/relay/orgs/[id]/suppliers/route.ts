import { NextRequest, NextResponse } from "next/server";
import { checkRelayKey, relayUnauthorized } from "@/lib/relay-auth";
import { getOrgSuppliers, resolveSource } from "@/lib/campaign-suppliers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  if (!checkRelayKey(request)) return relayUnauthorized();
  const source = resolveSource(request.nextUrl.searchParams.get("source"));
  try {
    const result = await getOrgSuppliers(source, params.id);
    const group = request.nextUrl.searchParams.get("group");
    if (group) {
      const bucket = (result.groups as Record<string, any[]>)[group];
      if (!bucket) return NextResponse.json({ error: `unknown group '${group}'` }, { status: 400 });
      return NextResponse.json({ source, org_id: result.org_id, group, count: bucket.length, suppliers: bucket });
    }
    return NextResponse.json({ source, ...result });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
