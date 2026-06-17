import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default function ClientDocumentsPage() {
  return (
    <div className="space-y-5 max-w-5xl">
      <Card className="tb-surface shadow-none">
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">Client uploads — POs, contracts, supplier docs, brochures.</p>
          <p className="text-xs text-muted-foreground mt-2 max-w-md mx-auto">
            Uploaded docs are parsed for material × supplier × price × date to build the reference benchmark. Upload and parsing
            land in a later stage.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
