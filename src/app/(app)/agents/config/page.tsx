import { redirect } from "next/navigation";
import { getSession, canSeeAgentTab } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StampToggle, RotateKeyButton } from "@/components/agent-config-controls";

export const dynamic = "force-dynamic";

export default async function AgentConfigPage() {
  const session = (await getSession())!;
  if (!canSeeAgentTab(session)) redirect("/");

  const admin = createAdminClient();
  const { data: agents } = await admin
    .from("agents")
    .select("id, slug, name, description, status, training_wheels_mode, stamp_of_approval, prompt_version, schedule_cron, api_key_prefix, last_run_at")
    .order("created_at");

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold">Agent configuration</h1>
        <p className="text-sm text-muted-foreground">Per-agent settings and Ben's stamp-of-approval gate.</p>
      </div>
      <div className="grid gap-4">
        {(agents ?? []).map((a: any) => (
          <Card key={a.id}>
            <CardHeader>
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <CardTitle className="text-base">{a.name}</CardTitle>
                  <CardDescription>{a.description ?? "—"}</CardDescription>
                </div>
                <div className="flex gap-1 items-center">
                  <Badge variant="secondary">{a.slug}</Badge>
                  <Badge variant={a.status === "running" ? "warn" : "outline"}>{a.status}</Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-4 text-sm">
              <div className="space-y-1">
                <Row label="Training wheels" value={a.training_wheels_mode ? "ON (staging mode)" : "OFF (direct push)"} />
                <Row label="Prompt version" value={`v${a.prompt_version}`} />
                <Row label="Schedule" value={a.schedule_cron ?? "(manual)"} />
                <Row label="Last run" value={a.last_run_at ?? "never"} />
                <Row label="API key" value={a.api_key_prefix ? `${a.api_key_prefix}…` : "(none — rotate to generate)"} />
              </div>
              <div className="space-y-3">
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Stamp of approval</div>
                  <StampToggle agentId={a.id} initial={a.stamp_of_approval} />
                  <p className="text-xs text-muted-foreground mt-1">Ben&apos;s gate. Until stamped, ops should treat outputs as drafts only.</p>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">API key</div>
                  <RotateKeyButton agentId={a.id} />
                  <p className="text-xs text-muted-foreground mt-1">Rotates the per-agent bearer token. The new token is shown once.</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {(!agents || agents.length === 0) && (
          <p className="text-sm text-muted-foreground">No agents registered yet.</p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[140px_1fr]">
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono text-xs">{value}</div>
    </div>
  );
}
