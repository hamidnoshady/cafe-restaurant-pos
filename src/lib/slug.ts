/**
 * Business slugs — the short, URL-safe, human-quotable handle for a tenant.
 *
 * Business names in this product are overwhelmingly Persian, which strips to
 * nothing under an ASCII-only slugifier. Rather than transliterate (lossy, and
 * a whole dependency), Persian and Arabic letters are kept as-is: Postgres,
 * URLs and the `citext` column all handle them fine, and a business that wants
 * a Latin handle can be given one explicitly.
 *
 * Framework-free and pure — covered by slug.test.ts.
 */

/** Characters allowed in a slug: ASCII alphanumerics, Persian/Arabic letters, and hyphens. */
const ALLOWED = /[^a-z0-9؀-ۿ‌-]/g;

/** Fallback stem when a name reduces to nothing usable. */
export const SLUG_FALLBACK = "biz";

export const MAX_SLUG_LENGTH = 48;

/**
 * A slug candidate for a business name.
 *
 * Returns "" when the name yields nothing usable, so the caller can decide
 * between a fallback and an error rather than being handed a silent default.
 */
export function slugifyBusinessName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    // Arabic-Indic and Persian digits → ASCII, so "کافه۱" and "کافه1" agree.
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    // Arabic letter variants Persian keyboards produce interchangeably.
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\s_]+/g, "-")
    .replace(ALLOWED, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return slug.slice(0, MAX_SLUG_LENGTH).replace(/-$/, "");
}

/**
 * Makes a slug unique against those already taken.
 *
 * Appends -2, -3, … rather than a random suffix so the common case stays
 * readable and the collision case stays predictable. `taken` is checked
 * case-insensitively to match the `citext` column it lands in.
 */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((s) => s.toLowerCase()));
  const stem = (base || SLUG_FALLBACK).slice(0, MAX_SLUG_LENGTH - 4).replace(/-$/, "");

  if (!used.has(stem)) return stem;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  // Astronomically unlikely; still better than looping forever.
  return `${stem}-${Date.now().toString(36)}`;
}
