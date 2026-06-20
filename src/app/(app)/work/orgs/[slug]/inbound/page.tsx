import { redirect } from "next/navigation";

// Merged into the unified Threads tab.
export default function Page({ params }: { params: { slug: string } }) {
  redirect(`/work/orgs/${params.slug}/threads`);
}
