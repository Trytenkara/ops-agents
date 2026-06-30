import { createAdminClient } from "@/lib/supabase/admin";
import { notFound } from "next/navigation";
import { getSession, hasAnyRole } from "@/lib/auth";
import { ClientProfilePanel, type ProfileValue, type SettingsValue, type UploadItem } from "@/components/client-profile-form";
import { getSourcingExclusionsDetail, type SourcingExclusionsDetail } from "@/lib/tenkara-sourcing-exclusions";
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

  // Do-not-contact list + excluded countries, read from this client's Tenkara
  // settings. Surfaced read-only so ops can confirm what sourcing (Agent 03) and
  // outreach (Agent 04) are suppressing. Best-effort — a Tenkara read hiccup
  // shouldn't break the profile.
  let dnc: SourcingExclusionsDetail | null = null;
  try {
    dnc = await getSourcingExclusionsDetail(org.tenkara_org_id);
  } catch {
    dnc = null;
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Contact, rep sheet, and a researched summary of this client — pulled from their Tenkara data, your settings, and
        uploads, and editable here.
      </p>

      <Link
        href={`/work/orgs/${org.slug}/materials`}
        className="group flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3 hover:bg-secondary/60 transition-colors"
      >
        <div>
          <div className="font-medium">Next: Materials &amp; sourcing</div>
          <div className="text-sm text-muted-foreground">What this client buys and where each one stands.</div>
        </div>
        <span className="text-muted-foreground group-hover:text-foreground" aria-hidden>→</span>
      </Link>

      <ClientProfilePanel orgId={org.id} slug={org.slug} profile={profile} settings={settings} uploads={uploads} canEdit={canEdit} />

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div>
          <h2 className="font-medium">Do-not-contact &amp; excluded countries</h2>
          <p className="text-sm text-muted-foreground">
            From this client&apos;s Tenkara settings. Lead sourcing (Agent 03) and outreach (Agent 04) automatically
            suppress these suppliers — they won&apos;t be surfaced as leads or emailed.
          </p>
        </div>

        {dnc === null ? (
          <p className="text-sm text-muted-foreground">Couldn&apos;t load the list right now — try refreshing.</p>
        ) : dnc.companies.length === 0 && dnc.countries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {org.tenkara_org_id
              ? "No do-not-contact companies or excluded countries configured for this client."
              : "This org isn’t linked to a Tenkara client yet, so there’s nothing to suppress."}
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                Do-not-contact companies ({dnc.companies.length})
              </div>
              {dnc.companies.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                <ul className="text-sm space-y-1">
                  {dnc.companies.map((c, i) => (
                    <li key={i} className="flex flex-col">
                      <span className="font-medium">{c.name ?? c.website}</span>
                      {c.website ? <span className="text-xs text-muted-foreground">{c.website}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                Excluded countries ({dnc.countries.length})
              </div>
              {dnc.countries.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {dnc.countries.map((c) => (
                    <span key={c} className="rounded-full bg-secondary px-2.5 py-0.5 text-xs">
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
