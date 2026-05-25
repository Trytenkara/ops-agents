import { createHash, randomBytes } from "crypto";
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface AuthedAgent {
  id: string;
  slug: string;
  name: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateAgentToken(): { raw: string; prefix: string; hash: string } {
  const raw = `oa_${randomBytes(24).toString("hex")}`;
  return { raw, prefix: raw.slice(0, 11), hash: hashToken(raw) };
}

export async function authenticateAgent(request: NextRequest): Promise<AuthedAgent | null> {
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const hash = hashToken(m[1]);
  const admin = createAdminClient();
  const { data } = await admin
    .from("agents")
    .select("id, slug, name")
    .eq("api_key_hash", hash)
    .maybeSingle();
  return data ?? null;
}

export function unauthorized() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
