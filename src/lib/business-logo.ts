/**
 * The business logo that prints on receipts and invoices (migration 0145's
 * `business.logo` setting).
 *
 * Stored as a `data:` URL inside the `settings` row rather than as a file on
 * disk or an object-storage key, for one concrete reason: the print agent
 * renders a document in a headless browser that has no session, and on a till
 * PC often no route back to the app server at all. Anything the page needs
 * must travel inside the HTML string. A data URL also survives the offline
 * queue and the Electron shell unchanged.
 *
 * That makes size the thing to police, so the cap is small and hard (256 KB of
 * decoded image, ~350 KB as base64) — a logo printed at 20mm on a 203 dpi
 * thermal head is about 160px tall, so nothing larger buys any ink.
 *
 * Pure validation here, no DB: the route does the I/O, and the rules are
 * testable as strings.
 */

export const LOGO_MAX_BYTES = 256 * 1024;

export const LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"] as const;
export type LogoMimeType = (typeof LOGO_MIME_TYPES)[number];

export interface BusinessLogo {
  /** `data:image/png;base64,…` — ready to drop into an <img src>. */
  dataUrl: string;
  mimeType: LogoMimeType;
  byteLength: number;
  updatedAt: string;
}

export function isLogoMimeType(value: unknown): value is LogoMimeType {
  return typeof value === "string" && (LOGO_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Cheap byte-signature check — the multipart MIME type is attacker-controlled,
 * so a "logo" that is really a script must not become an <img src> the print
 * agent's browser then loads. Mirrors website/content-service.ts's check, plus
 * SVG (which has no binary signature and is matched on its root element).
 */
export function hasMatchingLogoSignature(mimeType: string, bytes: Uint8Array): boolean {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (mimeType === "image/png") return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mimeType === "image/jpeg") return starts(0xff, 0xd8, 0xff);
  if (mimeType === "image/webp") {
    return starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  if (mimeType === "image/svg+xml") {
    const head = new TextDecoder().decode(bytes.slice(0, 1024)).toLowerCase();
    // An SVG is text, so the only real check is that it *is* an SVG document
    // and carries no script or external fetch. A thermal logo needs neither.
    if (!head.includes("<svg")) return false;
    const whole = new TextDecoder().decode(bytes).toLowerCase();
    return !whole.includes("<script") && !whole.includes("onload=") && !whole.includes("<foreignobject");
  }
  return false;
}

export function isValidLogo(input: { mimeType: string; byteLength: number }): boolean {
  return isLogoMimeType(input.mimeType) && input.byteLength > 0 && input.byteLength <= LOGO_MAX_BYTES;
}

/** Build the stored record from validated bytes. */
export function buildBusinessLogo(input: {
  mimeType: LogoMimeType;
  bytes: Uint8Array;
  now?: Date;
}): BusinessLogo {
  const base64 = Buffer.from(input.bytes).toString("base64");
  return {
    dataUrl: `data:${input.mimeType};base64,${base64}`,
    mimeType: input.mimeType,
    byteLength: input.bytes.byteLength,
    updatedAt: (input.now ?? new Date()).toISOString(),
  };
}

/** Whether a value read back out of `settings` is still a usable logo record. */
export function isStoredLogo(value: unknown): value is BusinessLogo {
  if (!value || typeof value !== "object") return false;
  const logo = value as BusinessLogo;
  return (
    typeof logo.dataUrl === "string" &&
    logo.dataUrl.startsWith("data:image/") &&
    isLogoMimeType(logo.mimeType)
  );
}
