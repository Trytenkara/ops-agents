import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const CHIPS = ["Replies", "Escalations", "Approvals", "Stalled exercises", "Price alerts", "Revalidations"];

export default function ClientQueuePage() {
  return (
    <div className="space-y-5 max-w-5xl">
      <div className="flex flex-wrap gap-1.5">
        {CHIPS.map((c, i) => (
          <span
            key={c}
            className={
              i === 0
                ? "inline-flex items-center rounded-full bg-foreground text-background px-3 py-1 text-xs font-medium"
                : "inline-flex items-center rounded-full bg-secondary text-muted-foreground px-3 py-1 text-xs"
            }
          >
            {c}
          </span>
        ))}
      </div>

      <Card className="tb-surface shadow-none">
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">Everything waiting on a human for this client.</p>
          <p className="text-xs text-muted-foreground mt-2 max-w-md mx-auto">
            Merges the old Cases and Approvals into one queue, filtered by the chips above. Built in the next stage.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
