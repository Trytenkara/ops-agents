import { TENKARA_INBOX_BASE } from "@/lib/tenkara";

// Inbound supplier replies on the Tenkara path can carry pricing as a file
// attachment (a PDF quote, an Excel/CSV price list, or a photographed price
// sheet) rather than inline text. Tenkara exposes attachment metadata on each
// conversation message and serves the bytes from an authenticated endpoint;
// this module fetches that metadata and downloads the bytes so the shared
// attachment parser can pull structured quote lines. Read-only.

export interface TenkaraAttachment {
  id: string;
  filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  is_inline: boolean;
  download_url: string | null; // relative to TENKARA_INBOX_BASE (e.g. /api/external/attachments/<id>)
}

const MAX_BYTES = 8 * 1024 * 1024; // 8MB — matches the attachment parser cap.

// Attachments for one message in a conversation. Tenkara returns them nested on
// each message of GET /api/external/conversations/{id}. Returns [] on any error.
export async function getTenkaraMessageAttachments(
  conversationId: string,
  messageId: string
): Promise<TenkaraAttachment[]> {
  const token = process.env.TENKARA_API_TOKEN;
  if (!token || !conversationId || !messageId) return [];
  try {
    const res = await fetch(
      `${TENKARA_INBOX_BASE}/api/external/conversations/${encodeURIComponent(conversationId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const msg = messages.find((m: any) => m?.id === messageId);
    const atts = Array.isArray(msg?.attachments) ? msg.attachments : [];
    return atts.map((a: any) => ({
      id: String(a.id),
      filename: a.filename ?? null,
      content_type: a.content_type ?? null,
      size_bytes: typeof a.size_bytes === "number" ? a.size_bytes : null,
      is_inline: !!a.is_inline,
      download_url: a.download_url ?? null,
    }));
  } catch {
    return [];
  }
}

// Download attachment bytes. The download_url is relative and the endpoint
// requires the API token. Returns null on error or if it exceeds the size cap.
export async function downloadTenkaraAttachment(att: TenkaraAttachment): Promise<Buffer | null> {
  const token = process.env.TENKARA_API_TOKEN;
  if (!token || !att.download_url) return null;
  if ((att.size_bytes ?? 0) > MAX_BYTES) return null;
  const url = att.download_url.startsWith("http")
    ? att.download_url
    : `${TENKARA_INBOX_BASE}${att.download_url}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_BYTES) return null;
    return Buffer.from(ab);
  } catch {
    return null;
  }
}
