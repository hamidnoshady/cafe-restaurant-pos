/**
 * Phase E — the structured chat input protocol (pure core).
 *
 * Until now the assistant had exactly two ways to end a turn: plain text, or a
 * `propose_action` write proposal. Anything it needed to *learn* from the user
 * — "which of these three suppliers did you mean?", "what date range?", "fill
 * in the missing amount" — it had to ask in prose and then parse a prose reply,
 * which is where a chat assistant most often goes wrong: it mishears a free-text
 * answer, or invents a value the user never gave.
 *
 * This module adds a third, typed way: `request_input`. The model emits a small
 * FORM SPEC (a bounded, validated document describing a choice, a multi-choice
 * or a set of typed fields); the UI renders it as a card; the user answers with
 * structured data; and that answer is validated against the very spec the model
 * emitted before it is ever fed back. The model can no longer "hear" an answer
 * that does not fit the question it asked.
 *
 * Everything here is deterministic and framework-free — no DB, no provider, no
 * `next/*` — exactly like `ai-automations.ts` and `ai-coworker.ts`. Persistence
 * lives in `ai-input-requests-service.ts`; the model tool declaration lives in
 * `ai.ts`; the card is a client component. The validation is the safety-
 * critical half and is unit-tested on its own.
 */

// ---------------------------------------------------------------------------
// Bounds — a request the model composes must stay small enough to render as one
// card and cheap enough to store. These are hard caps, enforced on the way in.
// ---------------------------------------------------------------------------

export const MAX_INPUT_PROMPT = 500;
export const MAX_INPUT_OPTIONS = 20;
export const MAX_INPUT_FIELDS = 12;
export const MAX_OPTION_LABEL = 200;
export const MAX_FIELD_LABEL = 200;
export const MAX_FIELD_KEY = 60;
export const MAX_TEXT_ANSWER = 2_000;

export const INPUT_REQUEST_KINDS = ["choice", "multi_choice", "form"] as const;
export type InputRequestKind = (typeof INPUT_REQUEST_KINDS)[number];

export const INPUT_FIELD_TYPES = ["text", "number", "date", "boolean", "select"] as const;
export type InputFieldType = (typeof INPUT_FIELD_TYPES)[number];

// ---------------------------------------------------------------------------
// The spec — what the model emits, after validation
// ---------------------------------------------------------------------------

export interface InputOption {
  /** Stable id the response refers to; the model supplies it. */
  id: string;
  label: string;
}

export interface InputField {
  key: string;
  label: string;
  type: InputFieldType;
  required: boolean;
  /** select only: the allowed options. */
  options?: InputOption[];
  placeholder?: string;
}

export interface InputRequestSpec {
  kind: InputRequestKind;
  /** The question shown above the card. */
  prompt: string;
  /** choice / multi_choice: the options to pick from. */
  options?: InputOption[];
  /** form: the typed fields to fill. */
  fields?: InputField[];
  /**
   * choice / multi_choice only: allow a free-text answer in addition to (or
   * instead of) the listed options — "none of these / other".
   */
  allowOther?: boolean;
}

// ---------------------------------------------------------------------------
// The response — what the user submits, after validation
// ---------------------------------------------------------------------------

export interface InputResponse {
  /** choice: the chosen option id (or null when `other` is used). */
  choice?: string | null;
  /** multi_choice: the chosen option ids. */
  choices?: string[];
  /** form: keyed answers. Values are string | number | boolean by field type. */
  values?: Record<string, string | number | boolean>;
  /** choice / multi_choice with allowOther: the free-text answer. */
  other?: string;
}

// ---------------------------------------------------------------------------
// Spec validation — reject, never coerce, a malformed request
// ---------------------------------------------------------------------------

export type SpecValidation =
  | { ok: true; spec: InputRequestSpec }
  | { ok: false; errors: string[] };

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeOptions(raw: unknown, errors: string[], context: string): InputOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${context}_options_required`);
    return [];
  }
  if (raw.length > MAX_INPUT_OPTIONS) errors.push(`${context}_too_many_options`);
  const seen = new Set<string>();
  const out: InputOption[] = [];
  for (const item of raw.slice(0, MAX_INPUT_OPTIONS)) {
    const obj = item as Record<string, unknown> | null;
    const id = str(obj?.id)?.trim();
    const label = str(obj?.label)?.trim();
    if (!id || !label) {
      errors.push(`${context}_invalid_option`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`${context}_duplicate_option`);
      continue;
    }
    seen.add(id);
    out.push({ id: id.slice(0, MAX_FIELD_KEY), label: label.slice(0, MAX_OPTION_LABEL) });
  }
  return out;
}

function normalizeFields(raw: unknown, errors: string[]): InputField[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push("fields_required");
    return [];
  }
  if (raw.length > MAX_INPUT_FIELDS) errors.push("too_many_fields");
  const seen = new Set<string>();
  const out: InputField[] = [];
  for (const item of raw.slice(0, MAX_INPUT_FIELDS)) {
    const obj = item as Record<string, unknown> | null;
    const key = str(obj?.key)?.trim();
    const label = str(obj?.label)?.trim();
    const type = str(obj?.type)?.trim() as InputFieldType | undefined;
    if (!key || !label) {
      errors.push("invalid_field");
      continue;
    }
    if (!type || !(INPUT_FIELD_TYPES as readonly string[]).includes(type)) {
      errors.push("invalid_field_type");
      continue;
    }
    if (seen.has(key)) {
      errors.push("duplicate_field_key");
      continue;
    }
    seen.add(key);
    const field: InputField = {
      key: key.slice(0, MAX_FIELD_KEY),
      label: label.slice(0, MAX_FIELD_LABEL),
      type,
      required: obj?.required === true,
    };
    if (type === "select") {
      const options = normalizeOptions(obj?.options, errors, "field");
      if (options.length > 0) field.options = options;
    }
    const placeholder = str(obj?.placeholder)?.trim();
    if (placeholder) field.placeholder = placeholder.slice(0, MAX_OPTION_LABEL);
    out.push(field);
  }
  return out;
}

/**
 * Validate a raw `request_input` payload from the model. Returns the cleaned
 * spec or a list of error codes; never coerces a broken request into a valid
 * one (a form with no fields is an error, not an empty form).
 */
export function validateInputRequest(raw: unknown): SpecValidation {
  const errors: string[] = [];
  const obj = (raw ?? {}) as Record<string, unknown>;

  const kind = str(obj.kind)?.trim() as InputRequestKind | undefined;
  if (!kind || !(INPUT_REQUEST_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, errors: ["invalid_kind"] };
  }

  const prompt = str(obj.prompt)?.trim();
  if (!prompt) errors.push("prompt_required");

  const spec: InputRequestSpec = { kind, prompt: (prompt ?? "").slice(0, MAX_INPUT_PROMPT) };

  if (kind === "choice" || kind === "multi_choice") {
    const options = normalizeOptions(obj.options, errors, "choice");
    if (options.length > 0) spec.options = options;
    if (obj.allowOther === true) spec.allowOther = true;
  } else {
    const fields = normalizeFields(obj.fields, errors);
    if (fields.length > 0) spec.fields = fields;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec };
}

// ---------------------------------------------------------------------------
// Response validation — the user's answer must fit the spec the model emitted
// ---------------------------------------------------------------------------

export type ResponseValidation =
  | { ok: true; response: InputResponse }
  | { ok: false; errors: string[] };

function coerceFieldValue(
  field: InputField,
  raw: unknown,
  errors: string[],
): string | number | boolean | undefined {
  switch (field.type) {
    case "text":
    case "date": {
      const value = str(raw)?.trim();
      if (!value) return undefined;
      // A date field must be a plain ISO calendar date; anything else is the
      // client sending a shape we never rendered.
      if (field.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        errors.push(`${field.key}:invalid_date`);
        return undefined;
      }
      return value.slice(0, MAX_TEXT_ANSWER);
    }
    case "number": {
      const value = typeof raw === "string" ? Number(raw) : raw;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${field.key}:invalid_number`);
        return undefined;
      }
      return value;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      errors.push(`${field.key}:invalid_boolean`);
      return undefined;
    }
    case "select": {
      const value = str(raw)?.trim();
      if (!value) return undefined;
      const allowed = new Set((field.options ?? []).map((o) => o.id));
      if (!allowed.has(value)) {
        errors.push(`${field.key}:invalid_option`);
        return undefined;
      }
      return value;
    }
  }
}

/**
 * Validate a submitted response against the spec the model emitted. Rejects an
 * answer that names an option that was never offered, omits a required field,
 * or is the wrong type — so the value fed back to the model is always one the
 * user could actually have chosen.
 */
export function validateInputResponse(spec: InputRequestSpec, raw: unknown): ResponseValidation {
  const errors: string[] = [];
  const obj = (raw ?? {}) as Record<string, unknown>;
  const response: InputResponse = {};

  if (spec.kind === "choice") {
    const optionIds = new Set((spec.options ?? []).map((o) => o.id));
    const choice = str(obj.choice)?.trim();
    const other = str(obj.other)?.trim();
    if (choice) {
      if (!optionIds.has(choice)) errors.push("invalid_choice");
      else response.choice = choice;
    } else if (spec.allowOther && other) {
      response.choice = null;
      response.other = other.slice(0, MAX_TEXT_ANSWER);
    } else {
      errors.push("choice_required");
    }
  } else if (spec.kind === "multi_choice") {
    const optionIds = new Set((spec.options ?? []).map((o) => o.id));
    const rawChoices = Array.isArray(obj.choices) ? obj.choices : [];
    const chosen: string[] = [];
    for (const item of rawChoices) {
      const id = str(item)?.trim();
      if (!id) continue;
      if (!optionIds.has(id)) {
        errors.push("invalid_choice");
        continue;
      }
      if (!chosen.includes(id)) chosen.push(id);
    }
    const other = str(obj.other)?.trim();
    if (chosen.length > 0) response.choices = chosen;
    if (spec.allowOther && other) response.other = other.slice(0, MAX_TEXT_ANSWER);
    if (chosen.length === 0 && !(spec.allowOther && other)) errors.push("choice_required");
  } else {
    // form
    const rawValues = (obj.values ?? {}) as Record<string, unknown>;
    const values: Record<string, string | number | boolean> = {};
    for (const field of spec.fields ?? []) {
      const value = coerceFieldValue(field, rawValues[field.key], errors);
      if (value === undefined) {
        if (field.required) errors.push(`${field.key}:required`);
        continue;
      }
      values[field.key] = value;
    }
    if (Object.keys(values).length > 0) response.values = values;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, response };
}

// ---------------------------------------------------------------------------
// Rendering the answer back to the model
// ---------------------------------------------------------------------------

/**
 * Turn a validated response into the plain-text message that becomes the user's
 * next turn — the labels the user actually saw, not the raw ids, so the model
 * reads "تأمین‌کننده: قهوهٔ آرام" rather than "choice: sup_3". Deterministic, so
 * the same answer always produces the same message (which keeps the transcript
 * and any cache stable).
 */
export function formatInputResponseForModel(spec: InputRequestSpec, response: InputResponse): string {
  const optionLabel = (options: InputOption[] | undefined, id: string): string =>
    options?.find((o) => o.id === id)?.label ?? id;

  const parts: string[] = [`[پاسخ فرم] ${spec.prompt}`];

  if (spec.kind === "choice") {
    if (response.choice) parts.push(`انتخاب: ${optionLabel(spec.options, response.choice)}`);
    else if (response.other) parts.push(`انتخاب (سایر): ${response.other}`);
  } else if (spec.kind === "multi_choice") {
    if (response.choices?.length) {
      parts.push(`انتخاب‌ها: ${response.choices.map((id) => optionLabel(spec.options, id)).join("، ")}`);
    }
    if (response.other) parts.push(`سایر: ${response.other}`);
  } else {
    for (const field of spec.fields ?? []) {
      if (response.values && field.key in response.values) {
        const value = response.values[field.key];
        const shown =
          field.type === "select"
            ? optionLabel(field.options, String(value))
            : field.type === "boolean"
              ? value === true
                ? "بله"
                : "خیر"
              : String(value);
        parts.push(`${field.label}: ${shown}`);
      }
    }
  }

  return parts.join("\n");
}

const SPEC_ERROR_FA: Record<string, string> = {
  invalid_kind: "نوع درخواست ورودی معتبر نیست.",
  prompt_required: "متن پرسش الزامی است.",
  choice_options_required: "برای پرسش گزینه‌ای باید گزینه‌ها را مشخص کنی.",
  choice_too_many_options: "تعداد گزینه‌ها بیش از حد مجاز است.",
  choice_invalid_option: "یکی از گزینه‌ها ساختار درستی ندارد.",
  choice_duplicate_option: "شناسهٔ گزینه‌ها نباید تکراری باشد.",
  fields_required: "برای فرم باید حداقل یک فیلد تعریف کنی.",
  too_many_fields: "تعداد فیلدها بیش از حد مجاز است.",
  invalid_field: "یکی از فیلدها ساختار درستی ندارد.",
  invalid_field_type: "نوع یکی از فیلدها معتبر نیست.",
  duplicate_field_key: "کلید فیلدها نباید تکراری باشد.",
  field_options_required: "فیلد انتخابی باید گزینه داشته باشد.",
};

export function inputSpecErrorMessage(code: string): string {
  return SPEC_ERROR_FA[code] ?? "درخواست ورودی نامعتبر است.";
}
