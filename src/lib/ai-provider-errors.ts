/**
 * Normalised, secret-safe diagnostics for OpenAI-compatible provider errors.
 *
 * LiteLLM can answer failures in several shapes: OpenAI's `{error:{...}}`,
 * FastAPI/Pydantic's `{detail:[...]}`, a plain `{detail:"..."}`, or raw text.
 * Tenant responses must not leak those infrastructure bodies, while operator
 * diagnostics need the exact reason that made the proxy reject a request.
 */

const MAX_DIAGNOSTIC_CHARS = 900;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._\-]+/gi;
const AUTHORIZATION_FIELD_PATTERN = /(authorization\s*[:=]\s*)Bearer\s+[A-Za-z0-9._\-]+/gi;
const SK_KEY_PATTERN = /sk-[A-Za-z0-9_\-]{8,}/g;
const NAMED_SECRET_FIELD_PATTERN = /(api[_-]?key|master[_-]?key|virtual[_-]?key)\s*[:=]\s*["']?[^"'\s,}]+/gi;

export interface NormalizedProviderError {
  status: number;
  message: string | null;
  type: string | null;
  code: string | null;
  param: string | null;
  detail: string | null;
  validation: string[];
  sanitizedBody: string | null;
}

function truncate(value: string, max = MAX_DIAGNOSTIC_CHARS): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export function sanitizeProviderText(value: unknown, max = MAX_DIAGNOSTIC_CHARS): string | null {
  if (value === null || value === undefined) return null;
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return null;
  text = text
    .replace(AUTHORIZATION_FIELD_PATTERN, (_match, prefix: string) => `${prefix}Bearer [redacted]`)
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SK_KEY_PATTERN, "sk-[redacted]")
    .replace(NAMED_SECRET_FIELD_PATTERN, (match) => match.replace(/[:=]\s*["']?[^"'\s,}]+/i, ": [redacted]"));
  return truncate(text, max);
}

function parseJson(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function stringField(source: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validationFromDetail(detail: unknown): string[] {
  if (!Array.isArray(detail)) return [];
  const out: string[] = [];
  for (const entry of detail) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const loc = Array.isArray(row.loc) ? row.loc.map(String).join(".") : stringField(row, "loc");
    const msg = stringField(row, "msg") ?? stringField(row, "message") ?? stringField(row, "type");
    const line = [loc, msg].filter(Boolean).join(": ");
    if (line) out.push(line);
  }
  return out.slice(0, 8);
}

function detailText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return sanitizeProviderText(value);
  if (Array.isArray(value)) {
    const validation = validationFromDetail(value);
    if (validation.length > 0) return sanitizeProviderText(validation.join("; "));
    return sanitizeProviderText(value);
  }
  if (value && typeof value === "object") return sanitizeProviderText(value);
  return null;
}

export function normalizeProviderError(status: number, rawBody: string): NormalizedProviderError {
  const parsed = parseJson(rawBody);
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
  const error = body?.error;
  const errorObj = error && typeof error === "object" && !Array.isArray(error)
    ? (error as Record<string, unknown>)
    : null;

  const message =
    stringField(errorObj, "message") ??
    (typeof error === "string" ? error.trim() : null) ??
    stringField(body, "message") ??
    (typeof body?.detail === "string" ? body.detail.trim() : null) ??
    (rawBody.trim() ? rawBody.trim() : null);

  const detail = detailText(body?.detail) ?? detailText(errorObj?.detail) ?? sanitizeProviderText(message);
  const validation = validationFromDetail(body?.detail).map((line) => sanitizeProviderText(line, 240) ?? line);

  return {
    status,
    message: sanitizeProviderText(message, 500),
    type: stringField(errorObj, "type") ?? stringField(body, "type"),
    code: stringField(errorObj, "code") ?? stringField(body, "code"),
    param: stringField(errorObj, "param") ?? stringField(body, "param"),
    detail,
    validation,
    sanitizedBody: sanitizeProviderText(parsed ?? rawBody),
  };
}

function genericStatusCode(value: string | null): boolean {
  return Boolean(value && /^\d{3}$/.test(value));
}

export function providerErrorReason(error: NormalizedProviderError | null | undefined): string | null {
  if (!error) return null;
  const validation = error.validation.length > 0 ? error.validation.join("; ") : null;
  const specificCode = genericStatusCode(error.code) ? null : error.code;
  return validation ?? error.detail ?? error.message ?? specificCode ?? error.type ?? error.sanitizedBody ?? error.code;
}

export function tenantProviderErrorMessage(status: number): string {
  if (status === 401 || status === 403) return "کلید سرویس هوش مصنوعی نامعتبر است.";
  if (status === 429) return "سرویس هوش مصنوعی در حال حاضر پرکاربرد است؛ کمی بعد دوباره تلاش کنید.";
  if (status >= 400 && status < 500) {
    return "درخواست توسط سرویس هوش مصنوعی رد شد. مدیر پلتفرم می‌تواند جزئیات فنی را بررسی کند.";
  }
  return "سرویس هوش مصنوعی در حال حاضر پاسخ معتبر نداد. کمی بعد دوباره تلاش کنید.";
}
