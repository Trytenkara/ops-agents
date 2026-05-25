export default function OutreachPage() {
  return <Placeholder title="Outreach" subtitle="Agent 01 (Initial Outreach) will surface its work here in Phase 3." />;
}

function Placeholder({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="rounded-lg border border-dashed p-12 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
    </div>
  );
}
