import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default function ClientOverviewPage() {
  return (
    <div className="space-y-6 max-w-5xl">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: "Materials sourcing", value: "—" },
          { label: "Active leads", value: "—" },
          { label: "Responses pending", value: "—" },
        ].map((s) => (
          <Card key={s.label} className="tb-surface shadow-none">
            <CardContent className="py-5">
              <div className="text-2xl font-serif">{s.value}</div>
              <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Sourcing exercises in progress</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Exercise list with status chips, priority items, and the savings headline land here in the next build stage.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
