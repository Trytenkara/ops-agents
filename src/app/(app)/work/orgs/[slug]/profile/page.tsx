import { createAdminClient } from "@/lib/supabase/admin";
import { notFound } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { ClientProfilePanel, type ProfileValue, type SettingsValue, type UploadItem } from "@/components/client-profile-form";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ClientProfilePage({ params }: { params: { slug: string } }) {
  const session = (await getSession())!;
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("id, slug, name, tenkara_org_id").eq("slug", params.slug).maybeSingle();
  if (!org) notFound();

  const [profileRes, settingsRes, uploadsRes] = await Promise.all([
    admin
      .from("client_profiles")
      .select("client_type, summary, highlights, sources, rep_sheet, last_generated_at, manual_override")
      .eq("org_id", org.id)
      .maybeSingle(),
    admin
      .from("client_settings")
      .select("outreach_mode, ghost_brand, priority_tier, primary_contact_name, primary_contact_email, sourcing_notes")
      .eq("org_id", org.id)
      .maybeSingle(),
    admin
      .from("client_uploads")
      .select("id, kind, file_name, content_text, created_at")
      .eq("org_id", org.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const p = profileRes.data as any;
  const profile: ProfileValue | null = p
    ? {
        client_type: p.client_type ?? null,
        summary: p.summary ?? null,
        highlights: Array.isArray(p.highlights) ? p.highlights : [],
        sources: Array.isArray(p.sources) ? p.sources : [],
        rep_sheet: p.rep_sheet && typeof p.rep_sheet === "object" ? p.rep_sheet : {},
        last_generated_at: p.last_generated_at ?? null,
        manual_override: !!p.manual_override,
      }
    : null;

  const settings: SettingsValue | null = settingsRes.data
    ? {
        outreach_mode: settingsRes.data.outreach_mode,
        ghost_brand: settingsRes.data.ghost_brand,
        priority_tier: settingsRes.data.priority_tier,
        primary_contact_name: settingsRes.data.primary_contact_name,
        primary_contact_email: settingsRes.data.primary_contact_email,
        sourcing_notes: settingsRes.data.sourcing_notes,
      }
    : null;

  const uploads = (uploadsRes.data ?? []) as UploadItem[];
  const canEdit = hasAnyRole(session, ["admin", "ops_lead", "ops_operator"]);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Contact, rep sheet, and a researched summary of this client — pulled from their Tenkara data, your settings, and
        uploads, and editable here.
      </p>
      <ClientProfilePanel orgId={org.id} profile={profile} settings={settings} uploads={uploads} canEdit={canEdit} />

      <Link
        href={`/work/orgs/${org.slug}/materials`}
        className="group flex items-center justify-between rounded-lg border border-border bg-background px-4 py-3 hover:bg-secondary/60 transition-colors"
      >
        <div>
          <div className="font-medium">Materials &amp; sourcing</div>
          <div className="text-sm text-muted-foreground">What this client buys and where each one stands.</div>
        </div>
        <span className="text-muted-foreground group-hover:text-foreground" aria-hidden>→</span>
      </Link>
    </div>
  );
}
