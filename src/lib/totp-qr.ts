/**
 * Phase 24 Wave 2 — the QR an authenticator app scans.
 *
 * Rendered server-side, in route handlers only, and handed to the browser as a
 * data URL. Two reasons it is not done in the client: the phase doc pins
 * `qrcode` to route handlers (never middleware, never a client bundle), and an
 * `otpauth://` URI is a *secret* — building the image next to the secret keeps
 * both on one side of the wire instead of shipping a QR library to render a
 * value the page already has.
 */
import QRCode from "qrcode";

/**
 * A PNG data URL for an `otpauth://totp/...` URI.
 *
 * Returns null rather than throwing: a missing QR degrades to the
 * type-it-by-hand secret the enrolment screen shows alongside it, and losing
 * the picture is not a reason to fail an enrolment.
 */
export async function totpQrDataUrl(otpauthUrl: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: "M", margin: 1, width: 240 });
  } catch (err) {
    console.error("Failed to render TOTP QR", err);
    return null;
  }
}
