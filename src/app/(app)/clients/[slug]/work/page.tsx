import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default function ClientWorkPage() {
  return (
    <div className="space-y-5 max-w-5xl">
      {/* Materials / Suppliers toggle (shape only — wired in the next stage). */}
      <div className="inline-flex rounded-lg bg-secondary p-0.5 text-sm">
        <span className="rounded-md bg-background px-3 py-1.5 font-medium shadow-sm">Materials</span>
        <span className="px-3 py-1.5 text-muted-foreground">Suppliers</span>
      </div>

      <Card className="tb-surface shadow-none">
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">
            The sourcing data lives here — one dataset, two lenses.
          </p>
          <p className="text-xs text-muted-foreground mt-2 max-w-md mx-auto">
            <strong>Materials</strong> (client lens) and <strong>Suppliers</strong> (ops lens) share this tab via the toggle above.
            Drill a material → supplier → quote. Built in the next stage.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
