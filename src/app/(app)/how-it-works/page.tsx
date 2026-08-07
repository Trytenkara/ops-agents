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
          <li>
            Agents never fabricate. An unreadable price is flagged with its reason, never estimated, and a contact detail
            stated in an email must be verified or the draft is blocked outright.
          </li>
          <li>
            Where a supplier gives us a person&apos;s name but no address, the agent builds the standard email patterns on that
            supplier&apos;s own domain and labels them as guessed, so you can see what is confirmed and what is a best guess
            before you send. It never guesses on a marketplace or platform domain.
          </li>
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

      <section className="space-y-3">
        <h2 className="font-serif text-xl">The contact cadence</h2>
        <p className="text-sm text-muted-foreground">
          Every offset below is counted from the day a supplier&apos;s first email is actually sent, so a follow-up sent late
          never drags the rest of the sequence with it. This applies to Active clients; Sourcing only and Off clients get
          no emails and no calls at all.
        </p>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-5">
          <li><span className="font-medium text-foreground">Day 0</span> — the sourcing inquiry goes out (you send it).</li>
          <li><span className="font-medium text-foreground">Day 1</span> — intro call. Raised whether or not they replied, to reach a person while the email is still fresh.</li>
          <li><span className="font-medium text-foreground">Day 2</span> — first follow-up email, staged in the same thread.</li>
          <li><span className="font-medium text-foreground">Day 4</span> — second follow-up email.</li>
          <li><span className="font-medium text-foreground">Day 5</span> — second call, only for suppliers who still have not written back.</li>
        </ul>
        <p className="text-sm text-muted-foreground">
          Calls land on the client&apos;s <span className="font-medium text-foreground">Call Tracker</span> tab, filterable by
          operator. Open a row for the number, the supplier&apos;s calling window in their own timezone, what we already emailed
          them, where the inbox thread stands right now, and what to ask for. Log the outcome, then close the row either by
          sending the supplier back into the email loop (your notes ride along) or by dropping them with a reason when they
          never came back on either channel.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-xl">Who gets the work</h2>
        <p className="text-sm text-muted-foreground">
          Set per client on its Overview → Operator assignment card. There is no Primary and no Backup: each operator on a
          client has a work type (Call operator or Email operator) and the market lanes they cover (Marketplace, Aggregator,
          Direct).
        </p>
        <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-5">
          <li>Type is per client, so the same person can take calls for one client and email for another, but never both on the same client.</li>
          <li>Work spreads across everyone who covers it rather than being pinned to one person. A supplier keeps a stable owner, so they always see one point of contact, and adding or removing an operator moves only about their share of the book.</li>
          <li>If nobody on a client covers a lane or a type, the work falls back to the whole pool for that client. Nothing is ever left unowned.</li>
        </ul>
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
