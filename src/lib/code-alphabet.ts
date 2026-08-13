/**
 * The human-typable alphabet and digit folding shared by every code this
 * product asks a person to read, type, or paste: pairing codes
 * (pairing-codes.ts) and server-sync tokens (sync-token.ts).
 *
 * It lives in its own file rather than in pairing-codes.ts — where it was
 * originally defined — for one concrete reason: pairing-codes.ts imports
 * `node:crypto`, and sync-token.ts is imported by a *client* component (the
 * sync settings tab validates a pasted token before the save round-trip), so
 * anything on that import path has to survive being bundled for the browser.
 * pairing-codes.ts re-exports `PAIRING_CODE_ALPHABET` from here, so the
 * alphabet still has exactly one definition and every existing importer keeps
 * working.
 */

/**
 * No O/0 and no I/1: a code's whole job is to survive being read aloud over
 * the phone and typed by someone who is not a developer. Exactly 32 symbols,
 * which is why `byte & 31` is an unbiased index into it.
 */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Persian and Arabic-Indic digits, folded to ASCII. */
const DIGIT_FOLD: Record<string, string> = {
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

/**
 * ASCII-fold any Persian/Arabic-Indic digits. Persian keyboards produce them
 * by default, so a copied code very often arrives this way.
 */
export function foldDigits(raw: string): string {
  return [...raw].map((ch) => DIGIT_FOLD[ch] ?? ch).join("");
}
