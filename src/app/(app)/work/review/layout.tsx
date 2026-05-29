import { ReviewTabs } from "@/components/review-tabs";

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl tracking-tight">Review queue</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Everything agents have staged for a human to triage — discovered leads, marketplace price changes, and outreach drafts.
        </p>
      </div>
      <ReviewTabs />
      {children}
    </div>
  );
}
