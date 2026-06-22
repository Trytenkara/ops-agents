import { redirect } from "next/navigation";

// Folded into the Price Index tab.
export default function Page({ params }: { params: { slug: string } }) {
  redirect(`/work/orgs/${params.slug}/price-index`);
}
