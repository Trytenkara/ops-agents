import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AGENT_SPECS } from "@/lib/agents-spec";
import { PipelineDiagram } from "@/components/pipeline-diagram";

export const metadata = { title: "How Tackle Box works" };

export default function HowItWorksPage() {
  const sorted = [...AGENT_SPECS].sort((a, b) => a.number - b.number);
  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <h1 className="font-serif text-3xl tracking-tight">How Tackle Box works</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Tackle Box is an internal ops hub. Eleven specialist agents do background work, but every action that touches the
          outside world — every email, every CSV upload to Tenkara — requires a human click. The agents stage; humans send.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="font-serif text-xl">Safety invariants</h2>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-5">
          <li>No emails are ever sent automatically. Missive drafts are staged with an empty from-address; operators pick the sender and click Send.</li>
          <li>No writes to Tenkara prod. Tackle Box only has a read-only client; all writes land in the ops-assistants Supabase project.</li>
          <li>Org access is gated by RLS plus app-layer filters. Operators only see the orgs they're assigned to.</li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="font-serif text-xl">Pipeline at a glance</h2>
        <p className="text-sm text-muted-foreground">
          The outreach happy path runs left to right. Agents do the automatic steps; the two cyan steps are where{" "}
          <span className="font-medium text-foreground">you</span> take over — promote a lead on{" "}
          <a href="/work/review/leads" className="underline hover:text-foreground">the Review queue</a>, and send the draft in Missive.
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
                  <CardTitle className="font-serif text-lg">
                    Agent {String(a.number).padStart(2, "0")} — {a.name}
                  </CardTitle>
                  <CardDescription>{a.cadence}</CardDescription>
                </div>
                <Badge variant={a.status === "shipped" ? "success" : "secondary"}>
                  {a.status === "shipped" ? "Shipped" : "Deferred"}
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
        Source of truth for descriptions: the <code>agents</code> table in the OA Supabase project, mirrored here from{" "}
        <code>docs/AGENTS-OVERVIEW.md</code>.
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
