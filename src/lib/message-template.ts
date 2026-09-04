/**
 * Phase 37 Wave 2 — message-template variable set and rendering.
 *
 * A message body is a small closed set of `{{…}}` placeholders the owner can
 * drop into text. The set is *closed and tested* (#374) — an unknown variable
 * is a validation error at save time, never an empty string at send time. Only
 * this module decides what a placeholder is, so a body that renders on the send
 * screen renders identically in the outbox.
 *
 * The allowed placeholders (Persian, as a café owner writes them):
 *   {{نام}}        customer name
 *   {{امتیاز}}     loyalty points balance
 *   {{اعتبار}}     store credit balance
 *   {{نام_فروشگاه}}  business name
 *   {{کد_تخفیف}}   a promo/discount code
 *
 * Amount-style values are rendered by the caller with the repo's display
 * conventions (formatToman, Persian digits) *before* substitution — this module
 * never formats money, it only substitutes what it is handed, so the value a
 * preview showed is byte-for-byte the value a recipient gets.
 */

/** The recognised placeholder names, as they appear between the braces. */
export const MESSAGE_TEMPLATE_VARIABLES = [
  "نام",
  "امتیاز",
  "اعتبار",
  "نام_فروشگاه",
  "کد_تخفیف",
] as const;

export type MessageTemplateVariable = (typeof MESSAGE_TEMPLATE_VARIABLES)[number];

export function isTemplateVariable(value: string): value is MessageTemplateVariable {
  return (MESSAGE_TEMPLATE_VARIABLES as readonly string[]).includes(value);
}

/** Placeholder tokens to substitute, keyed by their bare name. */
export type MessageTemplateValues = Partial<Record<MessageTemplateVariable, string>>;

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Extract every placeholder name used in `body` (deduplicated, in order of
 * first appearance). Used both for validation and for previewing which
 * variables a template needs.
 */
export function templateVariableTokens(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of body.matchAll(TOKEN_RE)) {
    const name = match[1].trim();
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Validate a body's placeholders against the closed set. Returns the list of
 * unknown variable names (empty when valid) rather than throwing, so a form can
 * show "این متغیرها شناخته‌شده نیستند: …" and let the owner fix them in place.
 */
export function unknownTemplateVariables(body: string): string[] {
  return templateVariableTokens(body).filter((name) => !isTemplateVariable(name));
}

/**
 * Render `body`, substituting every recognised placeholder from `values`.
 * Unknown placeholders are left untouched (callers must have validated first;
 * leaving them visible beats silently deleting text the owner wrote).
 * `{{برچسب}}`-style padding and surrounding whitespace inside the braces are
 * tolerated so the body is forgiving to authoring mistakes.
 */
export function renderMessageTemplate(body: string, values: MessageTemplateValues): string {
  return body.replace(TOKEN_RE, (full, rawName: string) => {
    const name = rawName.trim();
    if (isTemplateVariable(name)) {
      const value = values[name];
      return typeof value === "string" ? value : full;
    }
    return full;
  });
}
