import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default function ClientSettingsPage() {
  return (
    <div className="space-y-5 max-w-5xl">
      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Client configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Tone, ghost mode, compliance constraints, and sender identities for this client. Built in a later stage.
          </p>
        </CardContent>
      </Card>

      <Card className="tb-surface shadow-none">
        <CardHeader>
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground font-medium">Supplier assignments</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Assign operators to suppliers for this client (scoped per org). Newly scouted suppliers default to the Lead Operator.
            Built in a later stage.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
