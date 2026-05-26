import { createAdminClient } from "@/lib/supabase/admin";

const DEFAULT_BUCKET = "quote-revalidation-csvs";

export interface StoredCsv {
  path: string;
  signedUrl: string;
  expiresAt: string;
  sizeBytes: number;
}

export async function uploadCsvAndSign(opts: {
  filename: string;
  content: string;
  expiresInDays?: number;
  bucket?: string;
}): Promise<StoredCsv> {
  const admin = createAdminClient();
  const bucket = opts.bucket ?? DEFAULT_BUCKET;
  const path = `${new Date().toISOString().slice(0, 10)}/${opts.filename}`;
  const expiresIn = (opts.expiresInDays ?? 7) * 24 * 3600;

  const upload = await admin.storage.from(bucket).upload(path, opts.content, {
    contentType: "text/csv",
    upsert: true,
  });
  if (upload.error) throw new Error(`storage upload failed: ${upload.error.message}`);

  const signed = await admin.storage.from(bucket).createSignedUrl(path, expiresIn);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error(`signed URL failed: ${signed.error?.message ?? "unknown"}`);
  }

  return {
    path,
    signedUrl: signed.data.signedUrl,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    sizeBytes: opts.content.length,
  };
}
