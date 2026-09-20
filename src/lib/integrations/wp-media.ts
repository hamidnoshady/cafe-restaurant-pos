/**
 * Pure WordPress-media helpers shared by the mirrored-media service and its
 * dashboard section. Keeping these rules outside React/database code makes the
 * MIME filters and external-link boundary directly testable.
 */

export const WP_MEDIA_KINDS = ["all", "image", "video", "audio", "document"] as const;
export type WpMediaKind = (typeof WP_MEDIA_KINDS)[number];

export function isWpMediaKind(value: string | null | undefined): value is WpMediaKind {
  return WP_MEDIA_KINDS.includes(value as WpMediaKind);
}

/** The visual/filter group for a WordPress attachment MIME type. */
export function wpMediaKindForMime(mimeType: string | null | undefined): Exclude<WpMediaKind, "all"> {
  const mime = mimeType?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Only absolute HTTP(S) URLs may become a thumbnail or a clickable external
 * link in the manager. The mirror is fed by a remote WordPress installation;
 * returning a `javascript:` URL from that installation must never turn into a
 * script-bearing href in the owner's browser.
 */
export function safeWpExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > 2048) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}
