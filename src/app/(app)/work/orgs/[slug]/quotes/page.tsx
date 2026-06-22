import { redirect } from "next/navigation";

// Quotes + Approvals folded into the per-material drill-down on the Materials tab.
export default function Page({ params }: { params: { slug: string } }) {
  redirect(`/work/orgs/${params.slug}/materials`);
}
