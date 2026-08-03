import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AGENT_SPECS, agentLabel } from "@/lib/agents-spec";
import { PipelineDiagram } from "@/components/pipeline-diagram";

export const metadata = { title: "How Control Room works" };

export default function HowItWorksPage() {
  const sorted = [...AGENT_SPECS].sort((a, b) => (a.number ?? 99) - (b.number ?? 99));
  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <h1 className="font-serif text-3xl tracking-tight">How Control Room works</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Control Room is an internal ops hub. Specialist agents do the background work, but every action that touches the
          outside world (every email, every CSV upload to Tenkara) requires a human click. The agents stage; humans send.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="font-serif text-xl">Safety invariants</h2>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-5">
          <li>No emails are ever sent automatically. Drafts are staged in the Tenkara Inbox under Pending Outreach; operators review and click Send.</li>
          <li>No writes to Tenkara prod. Control Room only has a read-only client; all writes land in the ops-assistants Supabase project.</li>
          <li>Agents never fabricate. An unreadable price or an unverifiable contact is flagged with its reason, never guessed.</li>
          <li>Org access is gated by RLS plus app-layer filters. Operators only see the orgs they&apos;re assigned to.</li>
          <li>Each client carries a sourcing status (Active, Sourcing only, Off) that decides which agents touch it at all.</li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="font-serif text-xl">Pipeline at a glance</h2>
        <p className="text-sm text-muted-foreground">
          The outreach happy path runs left to right, handed between agents 03 (discovery), 06 (enrichment) and 04 (outreach); the
          cyan steps are where <span className="font-medium text-foreground">you</span> take over, reviewing and sending each draft in
          the Tenkara Inbox. You can Promote or Drop leads anytime on{" "}
          <a href="/work/review/leads" className="underline hover:text-foreground">the Review queue</a> or a client&apos;s Agent
          Supplier Leads tab.
        </p>
        <PipelineDiagram />
      </section>

      <section className="space-y-4">
        <h2 className="font-serif text-xl">Agents</h2>
        {sorted.map((a) => (
          <Card key={a.slug} className="tb-surface shadow-none">
            <CardHeader>
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <CardTitle className="font-serif text-lg">{agentLabel(a)}</CardTitle>
                  <CardDescription>{a.cadence}</CardDescription>
                </div>
                <Badge variant={a.status === "shipped" ? "success" : a.status === "paused" ? "warn" : "secondary"}>
                  {a.status === "shipped" ? "Shipped" : a.status === "paused" ? "Paused" : "Deferred"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Field label="Purpose" value={a.purpose} />
              <Field label="What it does automatically" value={a.automatic} />
              <Field label="What we expect from humans" value={a.humanInput} />
            </CardContent>
          </Card>
        ))}
      </section>

      <p className="text-xs text-muted-foreground">
        Descriptions live in <code>src/lib/agents-spec.ts</code>; schedules mirror the <code>agents</code> table in the OA
        Supabase project. Live status and per-run logs are under Agents (admin/monitor).
      </p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-3">
      <div className="text-muted-foreground">{label}</div>
      <div>{value}</div>
    </div>
  );
}
