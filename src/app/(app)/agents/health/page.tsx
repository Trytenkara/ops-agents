import { redirect } from "next/navigation";
import { getSession, canSeeAgentTab } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export default async function SystemHealthPage() {
  const session = (await getSession())!;
  if (!canSeeAgentTab(session)) redirect("/");

  const admin = createAdminClient();
  const { data: agents } = await admin.from("agents").select("name, slug, last_run_at, status");
  const { data: failedExports } = await admin.from("lead_scanner_exports").select("id").eq("status", "failed");

  const checks = [
    { name: "Supabase (OA DB)", ok: true, note: "connected (this page loaded)" },
    { name: "Slack bot token", ok: !!process.env.SLACK_BOT_TOKEN, note: process.env.SLACK_BOT_TOKEN ? "configured" : "missing" },
    { name: "Slack escalation channel", ok: !!process.env.SLACK_ESCALATION_CHANNEL_ID, note: process.env.SLACK_ESCALATION_CHANNEL_ID ?? "unset" },
    { name: "Service role key", ok: !!process.env.SUPABASE_SERVICE_ROLE_KEY, note: process.env.SUPABASE_SERVICE_ROLE_KEY ? "configured" : "missing" },
  ];

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-2xl font-semibold">System health</h1>
      <Card>
        <CardHeader><CardTitle className="text-base">Connectors</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {checks.map((c) => (
            <div key={c.name} className="flex items-center justify-between">
              <span>{c.name}</span>
              <span className="flex items-center gap-2">
                <Badge variant={c.ok ? "success" : "danger"}>{c.ok ? "OK" : "DOWN"}</Badge>
                <span className="text-xs text-muted-foreground">{c.note}</span>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Last run per agent</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(agents ?? []).map((a: any) => (
            <div key={a.slug} className="flex items-center justify-between">
              <span>{a.name}</span>
              <span className="text-muted-foreground text-xs">{a.last_run_at ?? "never"}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      {failedExports && failedExports.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Lead Scanner exports needing attention</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm">{failedExports.length} export(s) unacknowledged &gt;72h by Andrew.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
