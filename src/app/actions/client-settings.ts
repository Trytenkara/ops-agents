"use server";
import { getSession, hasAnyRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateClientProfile } from "@/lib/client-profile";
import { revalidatePath } from "next/cache";

interface Result { ok: boolean; error?: string }

const EDIT_ROLES = ["admin", "ops_lead", "ops_operator"] as const;

function clean(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

async function requireEditor() {
  const session = await getSession();
  if (!session) return { error: "unauthenticated" as const };
  if (!hasAnyRole(session, [...EDIT_ROLES])) return { error: "forbidden" as const };
  return { session };
}

export interface ClientSettingsInput {
  outreach_mode: "active" | "ghost" | "skip";
  ghost_brand: string | null;
  priority_tier: "standard" | "priority" | "vip";
  primary_contact_name: string | null;
  primary_contact_email: string | null;
  sourcing_notes: string | null;
}

// Save the optional ops-entered inputs. These feed the next generation; they
// are not the profile itself.
export async function saveClientSettings(orgId: string, input: ClientSettingsInput): Promise<Result> {
  const auth = await requireEditor();
  if (auth.error) return { ok: false, error: auth.error };
  const admin = createAdminClient();
  const { error } = await admin.from("client_settings").upsert(
    {
      org_id: orgId,
      outreach_mode: input.outreach_mode,
      ghost_brand: clean(input.ghost_brand),
      priority_tier: input.priority_tier,
      primary_contact_name: clean(input.primary_contact_name),
      primary_contact_email: clean(input.primary_contact_email),
      sourcing_notes: clean(input.sourcing_notes),
      status: "draft",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "org_id" }
  );
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/work/orgs`);
  return { ok: true };
}

// Save just the sourcing notes (edited from the Materials tab's PO area). Kept
// separate so saving notes never clobbers the other client settings.
export async function saveSourcingNotes(orgId: string, notes: string | null): Promise<Result> {
  const auth = await requireEditor();
  if (auth.error) return { ok: false, error: auth.error };
  const admin = createAdminClient();
  const { error } = await admin.from("client_settings").upsert(
    { org_id: orgId, sourcing_notes: clean(notes), updated_at: new Date().toISOString() },
    { onConflict: "org_id" }
  );
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/work/orgs`);
  return { ok: true };
}

// Run the research generation for one client. force=true overrides a prior
// manual edit (the explicit "Regenerate" path).
export async function generateClientProfileAction(orgId: string, force = false): Promise<Result> {
  const auth = await requireEditor();
  if (auth.error) return { ok: false, error: auth.error };
  const admin = createAdminClient();
  const res = await generateClientProfile(admin, orgId, { force });
  if (res.status === "error") return { ok: false, error: res.error };
  if (res.status === "no_org") return { ok: false, error: "org not found" };
  revalidatePath(`/work/orgs`);
  return { ok: true };
}

// Ops correction. Marks the profile manual_override so auto-refresh won't clobber it.
export async function editClientProfile(
  orgId: string,
  patch: { summary?: string; client_type?: "active" | "ghost" | "skip" | "prospect"; rep_sheet?: Record<string, string | null> }
): Promise<Result> {
  const auth = await requireEditor();
  if (auth.error) return { ok: false, error: auth.error };
  const admin = createAdminClient();
  const update: Record<string, any> = { manual_override: true, updated_at: new Date().toISOString() };
  if (patch.summary !== undefined) update.summary = patch.summary;
  if (patch.client_type !== undefined) update.client_type = patch.client_type;
  if (patch.rep_sheet !== undefined) update.rep_sheet = patch.rep_sheet;
  const { error } = await admin.from("client_profiles").update(update).eq("org_id", orgId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/work/orgs`);
  return { ok: true };
}

// Add a pasted note. Stored, then folded into the profile on the next generate.
export async function addClientNote(orgId: string, text: string, autoGenerate = true): Promise<Result> {
  const auth = await requireEditor();
  if (auth.error) return { ok: false, error: auth.error };
  const body = clean(text);
  if (!body) return { ok: false, error: "empty note" };
  const admin = createAdminClient();
  const { error } = await admin.from("client_uploads").insert({
    org_id: orgId,
    kind: "note",
    content_text: body,
    created_by: auth.session!.userId,
  });
  if (error) return { ok: false, error: error.message };
  if (autoGenerate) await generateClientProfile(admin, orgId, { force: false });
  revalidatePath(`/work/orgs`);
  return { ok: true };
}

// Upload a file. Text/markdown content is extracted inline; other types are
// stored and referenced (text extraction for those is a fast-follow).
const UPLOAD_BUCKET = "client-uploads";
export async function uploadClientFile(orgId: string, form: FormData): Promise<Result> {
  const auth = await requireEditor();
  if (auth.error) return { ok: false, error: auth.error };
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "no file" };
  if (file.size > 5 * 1024 * 1024) return { ok: false, error: "file too large (max 5MB)" };

  const admin = createAdminClient();
  const bytes = Buffer.from(await file.arrayBuffer());
  const isText = /^text\/|markdown|json|csv/.test(file.type) || /\.(txt|md|markdown|csv|json)$/i.test(file.name);
  const path = `${orgId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

  const up = await admin.storage.from(UPLOAD_BUCKET).upload(path, bytes, {
    contentType: file.type || "application/octet-stream",
    upsert: true,
  });
  if (up.error) return { ok: false, error: `upload failed: ${up.error.message}` };

  const { error } = await admin.from("client_uploads").insert({
    org_id: orgId,
    kind: "file",
    file_path: path,
    file_name: file.name,
    content_text: isText ? bytes.toString("utf8").slice(0, 20000) : null,
    created_by: auth.session!.userId,
  });
  if (error) return { ok: false, error: error.message };

  await generateClientProfile(admin, orgId, { force: false });
  revalidatePath(`/work/orgs`);
  return { ok: true };
}
