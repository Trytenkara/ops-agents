import { redirect } from "next/navigation";
import { getSession, canSeeAgentTab } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StampToggle, RotateKeyButton } from "@/components/agent-config-controls";
import { RunNowButton } from "@/components/run-now-button";
import { relativeTime } from "@/lib/utils";
import { PageExplainer } from "@/components/page-explainer";
import { agentNumberFromSlug } from "@/lib/agents-sort";

export const dynamic = "force-dynamic";

export default async function AgentConfigPage() {
  const session = (await getSession())!;
  if (!canSeeAgentTab(session)) redirect("/");

  const admin = createAdminClient();
  const { data: agentsRaw } = await admin
    .from("agents")
    .select("id, slug, name, description, status, runtime, training_wheels_mode, stamp_of_approval, prompt_version, schedule_cron, api_key_prefix, last_run_at, current_run_id, locked_until");
  // Sort by the leading number in the slug (agent-01-…, agent-02-…) so the
  // list reads 01..11 left-to-right regardless of registration order.
  const agents = [...(agentsRaw ?? [])].sort(
    (a: any, b: any) => agentNumberFromSlug(a.slug) - agentNumberFromSlug(b.slug)
  );

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="font-serif text-3xl tracking-tight">Agent configuration</h1>
        <p className="text-sm text-muted-foreground mt-1">Per-agent settings, runtime, and the stamp-of-approval gate.</p>
      </div>
      <PageExplainer tag="Per-agent controls.">
        Training wheels stage drafts for review instead of acting directly. The stamp-of-approval gate must be on before an agent can run on cron.
        See <a href="/how-it-works" className="underline hover:text-foreground">How Tackle Box works</a> for what each agent does.
      </PageExplainer>
      <div className="grid gap-4">
        {agents.map((a: any) => {
          const isRunning = a.locked_until && new Date(a.locked_until) > new Date();
          return (
          <Card key={a.id} className="tb-surface shadow-none">
            <CardHeader>
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <CardTitle className="font-serif text-xl">{a.name}</CardTitle>
                  <CardDescription>{a.description ?? "—"}</CardDescription>
                </div>
                <div className="flex gap-1 items-center">
                  <Badge variant="secondary">{a.slug}</Badge>
                  <Badge variant={a.runtime === "embedded" ? "default" : "outline"}>{a.runtime === "embedded" ? "Embedded" : "External"}</Badge>
                  <Badge variant={isRunning ? "warn" : "outline"}>{isRunning ? "running" : a.status}</Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid md:grid-cols-2 gap-4 text-sm">
              <div className="space-y-1">
                <Row label="Training wheels" value={a.training_wheels_mode ? "ON (staging mode)" : "OFF (direct push)"} />
                <Row label="Prompt version" value={`v${a.prompt_version}`} />
                <Row label="Schedule" value={a.schedule_cron ?? "(manual)"} />
                <Row label="Last run" value={a.last_run_at ? relativeTime(a.last_run_at) : "never"} />
                {a.runtime === "external" && (
                  <Row label="API key" value={a.api_key_prefix ? `${a.api_key_prefix}…` : "(none — rotate to generate)"} />
                )}
              </div>
              <div className="space-y-3">
                {a.runtime === "embedded" ? (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Trigger</div>
                    <RunNowButton agentSlug={a.slug} isRunning={!!isRunning} currentRunId={a.current_run_id} />
                    <p className="text-xs text-muted-foreground mt-1">
                      Runs inside Tackle Box. {a.schedule_cron ? "Also runs on cron schedule." : "No schedule — manual trigger only."}
                    </p>
                  </div>
                ) : (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">API key</div>
                    <RotateKeyButton agentId={a.id} />
                    <p className="text-xs text-muted-foreground mt-1">External agent. Rotates the per-agent bearer token (used by SuperAgent).</p>
                  </div>
                )}
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Stamp of approval</div>
                  <StampToggle agentId={a.id} initial={a.stamp_of_approval} />
                  <p className="text-xs text-muted-foreground mt-1">Until stamped, agents run only in training-wheels mode.</p>
                </div>
              </div>
            </CardContent>
          </Card>
          );
        })}
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
