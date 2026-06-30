import type { createAdminClient } from "@/lib/supabase/admin";
import type { MissiveAttachment } from "@/lib/missive";
import { uploadBinaryFile } from "@/lib/storage";
import { postAgentAlert } from "@/lib/slack-alert";

// Supplier form escalation (part of Agent 15). When a supplier emails a form for
// the client to fill or sign (credit reference, new-account/vendor setup, W-9,
// NDA, banking), we DON'T fill it — we pull the attachment, store it in a
// private bucket, open a Case recording the form type, and notify ops so a
// human handles it.

const FORM_BUCKET = "supplier-forms";
const MAX_FORM_BYTES = 25 * 1024 * 1024; // 25MB cap on a downloaded form

type Ctx = { agentId: string | null; runId: string | null; log: (m: string, o?: any) => Promise<void> };
type Admin = ReturnType<typeof createAdminClient>;

const FORM_TYPE_LABEL: Record<string, string> = {
  credit_reference: "credit reference",
  new_account: "new-account / vendor setup",
  w9_tax: "W-9 / tax",
  nda: "NDA",
  banking: "banking / ACH",
  other: "form",
};

function sanitizeFilename(name: string): string {
  return (name || "form").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

// Pick the attachment most likely to be the form: prefer a document over an
// inline image (signatures/logos), and a larger file over a tiny one.
function pickFormAttachment(attachments: MissiveAttachment[]): MissiveAttachment | null {
  const usable = attachments.filter((a) => a.url && a.filename);
  if (usable.length === 0) return null;
  const docExt = /\.(pdf|docx?|xlsx?|rtf|odt|pages)$/i;
  const docs = usable.filter((a) => docExt.test(a.filename) || a.sub_type === "pdf" || a.media_type === "file");
  const pool = docs.length ? docs : usable.filter((a) => a.media_type !== "image");
  const candidates = pool.length ? pool : usable;
  return candidates.sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0] ?? null;
}

async function downloadAttachment(url: string): Promise<{ buf: Buffer; contentType: string } | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const ab = await res.arrayBuffer();
  if (ab.byteLength === 0 || ab.byteLength > MAX_FORM_BYTES) return null;
  return { buf: Buffer.from(ab), contentType };
}

export interface FormEscalationInput {
  head: any; // a draft_references row (org_id, supplier_id, material_id, assigned_operator, thread_id)
  threadId: string;
  supplierName: string | null;
  supplierEmail: string | null;
  formType: string;
  attachments: MissiveAttachment[];
}

// Returns true if a new case was opened. Idempotent: skips if an open
// supplier_form case already exists for this thread.
export async function handleSupplierForm(ctx: Ctx, admin: Admin, input: FormEscalationInput): Promise<boolean> {
  const { head, threadId, supplierName, supplierEmail, formType, attachments } = input;
  const typeLabel = FORM_TYPE_LABEL[formType] ?? FORM_TYPE_LABEL.other;
  const who = supplierName ?? supplierEmail ?? "a supplier";

  // De-dup: one open form case per thread.
  const { data: existing } = await admin
    .from("cases")
    .select("id")
    .eq("type", "supplier_form")
    .in("status", ["open", "in_progress"])
    .eq("originating_thread_id", threadId)
    .maybeSingle();
  if (existing) return false;

  // Try to pull the form file. Missive exposes attachments; the Tenkara/rod_app
  // path doesn't yet, so we still open the case and tell ops to grab it from the
  // thread.
  let storagePath: string | null = null;
  let filename: string | null = null;
  let sizeBytes: number | null = null;
  const att = pickFormAttachment(attachments ?? []);
  if (att) {
    try {
      const dl = await downloadAttachment(att.url);
      if (dl) {
        filename = sanitizeFilename(att.filename);
        const path = `${head.org_id ?? "unscoped"}/${threadId}-${filename}`;
        await uploadBinaryFile({ bucket: FORM_BUCKET, path, content: dl.buf, contentType: dl.contentType });
        storagePath = path;
        sizeBytes = dl.buf.length;
      } else {
        await ctx.log(`Form attachment for ${who} couldn't be downloaded (empty or too large)`, { level: "warn", step: "form" });
      }
    } catch (e: any) {
      await ctx.log(`Form attachment store failed for ${who}: ${e?.message ?? e}`, { level: "warn", step: "form" });
    }
  }

  const action = storagePath
    ? `Supplier ${who} sent a ${typeLabel} form. Download it from this case, complete/route it as needed, and reply. The agent does not fill forms.`
    : `Supplier ${who} sent a ${typeLabel} form, but the file couldn't be auto-pulled — open the email thread to retrieve it. The agent does not fill forms.`;

  const { error: caseErr } = await admin.from("cases").insert({
    org_id: head.org_id,
    type: "supplier_form",
    status: "open",
    supplier_id: head.supplier_id ?? null,
    material_id: head.material_id ?? null,
    originating_thread_id: threadId,
    recommended_action: action,
    assigned_operator: head.assigned_operator ?? null,
    metadata: {
      source_agent: "agent-15-reply-manager",
      source_run_id: ctx.runId,
      case_category: "supplier_form",
      form_type: formType,
      form_filename: filename,
      form_bucket: FORM_BUCKET,
      form_storage_path: storagePath,
      form_size_bytes: sizeBytes,
      form_available: !!storagePath,
      supplier_name: supplierName,
      supplier_contact_email: supplierEmail,
    },
  });
  if (caseErr) {
    await ctx.log(`Supplier-form case insert failed for ${who}: ${caseErr.message}`, { level: "warn", step: "form" });
    return false;
  }

  await postAgentAlert(
    `:page_facing_up: *${typeLabel} form received* from *${who}* (${supplierEmail ?? "?"}).` +
      (storagePath ? ` Download it from the client's Cases tab.` : ` Couldn't auto-pull the file — grab it from the email thread.`) +
      ` The agent will NOT complete it — please handle.`
  );

  await ctx.log(`Supplier-form case opened for ${who} (${formType}${storagePath ? ", file stored" : ", no file"})`, { step: "form" });
  return true;
}
