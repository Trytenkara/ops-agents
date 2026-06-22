import { redirect } from "next/navigation";

// Re-quote drafts now live on the Price Index tab.
export default function Page({ params }: { params: { slug: string } }) {
  redirect(`/work/orgs/${params.slug}/price-index`);
}
