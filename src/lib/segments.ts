/**
 * The customer segment engine — pure, framework-free, and the only place a
 * user-authored rule becomes SQL.
 *
 * «مشتری‌هایی که سه ماه است نیامده‌اند و بیش از دو میلیون تومان خرید کرده‌اند»
 * has to be a *thing with a name* before anything can be done with it. That is
 * what a segment is: a **rule document**, stored as JSON, resolved at the
 * moment it is used. Not a frozen list of ids — a list goes stale the next
 * time someone buys something, and then the owner is messaging last quarter's
 * customers.
 *
 * ## Why a compiler and not a query builder
 *
 * The rule comes from a form an owner filled in, so it is untrusted input that
 * has to become a `WHERE` clause. Two properties make that safe here, and they
 * are the reason this file exists at all:
 *
 * 1. **Every column name comes from a closed union.** A rule names a `field`;
 *    `FIELD_SQL` maps that field to a SQL fragment this file wrote. An unknown
 *    field is rejected, never interpolated. The same discipline
 *    `reports.ts` uses for its view whitelist.
 * 2. **Every value is a bound parameter.** Nothing a user typed is ever
 *    concatenated into the string — not a number, not a tag, not a date. The
 *    compiler returns `{ sql, params }` and the caller binds them.
 *
 * Together those make injection impossible *by construction* rather than by
 * careful review, which is the only kind of guarantee worth having on a path
 * where the input is a text field in a marketing screen.
 *
 * ## Conventions this file inherits
 *
 * - **Money is integer Rial** (the repo-wide storage convention). A rule holds
 *   Rial; the form takes Toman and converts. The compiler never sees Toman.
 * - **Dates are Gregorian ISO** in storage and on the wire; Shamsi is a display
 *   concern and never appears here.
 * - **"Last purchase" is anchored on a date the caller passes in**, not on
 *   `now()` inside SQL: the branch's business day is not the calendar day (a
 *   café trading past midnight files 01:00 under the previous day), so the
 *   caller resolves the business date and hands it over. A `now()` in this
 *   file would silently answer about the wrong day for every late-night venue.
 */

/** Aggregates over a customer's order history, computed in the compiled CTE. */
export type SegmentField =
  | "lastPurchaseAt"
  | "firstPurchaseAt"
  | "totalSpentRial"
  | "orderCount"
  | "averageOrderRial"
  | "tags"
  | "birthdayMonth"
  | "loyaltyPoints"
  | "isActive"
  | "hasEmail"
  | "smsConsent"
  | "marketingConsent"
  | "city"
  | "createdAt";

export type SegmentRule =
  /** Days since/before the last purchase, relative to the anchor date. */
  | { field: "lastPurchaseAt"; op: "before" | "after"; days: number }
  /** Same, for the very first purchase — "customers who joined in the last 30 days". */
  | { field: "firstPurchaseAt"; op: "before" | "after"; days: number }
  | { field: "totalSpentRial"; op: "gte" | "lte"; value: number }
  | { field: "orderCount"; op: "gte" | "lte"; value: number }
  | { field: "averageOrderRial"; op: "gte" | "lte"; value: number }
  | { field: "tags"; op: "hasAny" | "hasAll" | "hasNone"; values: string[] }
  /** The Gregorian month of the stored birthday (1-12) — the birthday campaign's rule. */
  | { field: "birthdayMonth"; op: "is"; month: number }
  | { field: "loyaltyPoints"; op: "gte" | "lte"; value: number }
  | { field: "isActive"; op: "is"; value: boolean }
  | { field: "hasEmail"; op: "is"; value: boolean }
  | { field: "smsConsent"; op: "is"; value: boolean }
  | { field: "marketingConsent"; op: "is"; value: boolean }
  | { field: "city"; op: "contains"; value: string }
  | { field: "createdAt"; op: "before" | "after"; days: number };

/**
 * A rule document. `all` is AND, `any` is OR, and a document carrying both
 * means "all of these AND at least one of those" — which is what an owner
 * means by «مشتری‌های وفادار که یا تهران‌اند یا ایمیل دارند».
 *
 * An empty document matches every customer. That is deliberate and is what
 * makes «همهٔ مشتریان» expressible without a special case, but it is also why
 * `resolveSegment` refuses to treat an empty document as an audience for a
 * *send* without an explicit purpose filter.
 */
export interface SegmentDefinition {
  all?: SegmentRule[];
  any?: SegmentRule[];
}

export interface CompiledSegment {
  /** A boolean SQL expression over the compiler's own aliases. Never contains user text. */
  sql: string;
  /** Bound values, in `$n` order starting at `paramOffset + 1`. */
  params: unknown[];
}

export interface CompileOptions {
  /**
   * The date "days ago" is measured from — the branch's **business date**, ISO
   * Gregorian. Required: defaulting it here would hide the business-day
   * question from every caller, which is exactly how a late-night café ends up
   * with an off-by-one-day segment.
   */
  anchorDate: string;
  /** Number of parameters already bound by the caller, so `$n` continues correctly. */
  paramOffset?: number;
}

/**
 * Field → the SQL expression it compares against.
 *
 * These reference aliases the segment CTE (`segmentSourceSql`) guarantees, so
 * the compiler and the query it is embedded in cannot drift apart. Everything
 * here is a compile-time constant written in this file: no user input reaches
 * it, which is the whole point.
 */
const FIELD_SQL: Record<SegmentField, string> = {
  lastPurchaseAt: "s.last_purchase_date",
  firstPurchaseAt: "s.first_purchase_date",
  totalSpentRial: "s.total_spent",
  orderCount: "s.order_count",
  averageOrderRial: "s.average_order",
  tags: "c.tags",
  birthdayMonth: "EXTRACT(MONTH FROM c.birthday)",
  loyaltyPoints: "s.loyalty_points",
  isActive: "c.is_active",
  hasEmail: "(c.email IS NOT NULL AND btrim(c.email) <> '')",
  smsConsent: "c.sms_consent",
  marketingConsent: "c.marketing_consent",
  city: "coalesce(c.address, '')",
  createdAt: "c.created_at::date",
};

export class SegmentRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SegmentRuleError";
  }
}

function assertFiniteNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SegmentRuleError(`${what} must be a finite number`);
  }
  return value;
}

function assertInteger(value: unknown, what: string): number {
  const n = assertFiniteNumber(value, what);
  if (!Number.isInteger(n)) throw new SegmentRuleError(`${what} must be an integer`);
  return n;
}

/** Type guard for a field name, so an unknown key is rejected before it can reach `FIELD_SQL`. */
export function isSegmentField(value: unknown): value is SegmentField {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(FIELD_SQL, value);
}

/**
 * Compile one rule into a boolean expression plus its bound values.
 *
 * `bind` appends to the shared parameter array and returns the `$n` marker, so
 * every value in the finished statement is a parameter and the numbering is
 * correct however deeply the rules nest.
 */
function compileRule(
  rule: SegmentRule,
  bind: (value: unknown) => string,
  options: CompileOptions,
): string {
  if (!rule || typeof rule !== "object" || !isSegmentField((rule as SegmentRule).field)) {
    throw new SegmentRuleError(`Unknown segment field: ${String((rule as { field?: unknown })?.field)}`);
  }
  const column = FIELD_SQL[rule.field];

  switch (rule.field) {
    case "lastPurchaseAt":
    case "firstPurchaseAt":
    case "createdAt": {
      const days = assertInteger(rule.days, "days");
      if (days < 0) throw new SegmentRuleError("days must not be negative");
      // The cutoff is computed in SQL from the *anchor* date the caller
      // resolved (the business day), never from now(): see the file header.
      const anchor = bind(options.anchorDate);
      const interval = bind(`${days} days`);
      const cutoff = `(${anchor}::date - ${interval}::interval)::date`;
      if (rule.op === "before") {
        // "hasn't bought in 90 days" must include "has never bought at all",
        // which is the whole population a win-back campaign is aimed at. A
        // plain `<` on a NULL column silently drops exactly those customers.
        return rule.field === "createdAt"
          ? `${column} < ${cutoff}`
          : `(${column} IS NULL OR ${column} < ${cutoff})`;
      }
      if (rule.op === "after") return `${column} >= ${cutoff}`;
      throw new SegmentRuleError(`Unsupported operator for ${rule.field}: ${String(rule.op)}`);
    }

    case "totalSpentRial":
    case "orderCount":
    case "averageOrderRial":
    case "loyaltyPoints": {
      const value = assertFiniteNumber(rule.value, "value");
      if (rule.op !== "gte" && rule.op !== "lte") {
        throw new SegmentRuleError(`Unsupported operator for ${rule.field}: ${String(rule.op)}`);
      }
      // coalesce: a customer with no orders has spent zero, not "unknown" —
      // otherwise «کمتر از ۱۰۰ هزار تومان خرید کرده» would exclude the
      // customers who have spent nothing at all.
      return `coalesce(${column}, 0) ${rule.op === "gte" ? ">=" : "<="} ${bind(value)}`;
    }

    case "tags": {
      if (!Array.isArray(rule.values)) throw new SegmentRuleError("tags rule needs a values array");
      const values = rule.values.filter((v): v is string => typeof v === "string" && v.trim() !== "");
      // An empty tag list is not a filter. Returning TRUE (rather than
      // throwing) lets a half-filled form preview sensibly instead of erroring
      // on every keystroke.
      if (values.length === 0) return "TRUE";
      const bound = bind(values);
      if (rule.op === "hasAny") return `${column} && ${bound}::text[]`;
      if (rule.op === "hasAll") return `${column} @> ${bound}::text[]`;
      if (rule.op === "hasNone") return `NOT (${column} && ${bound}::text[])`;
      throw new SegmentRuleError(`Unsupported operator for tags: ${String(rule.op)}`);
    }

    case "birthdayMonth": {
      const month = assertInteger(rule.month, "month");
      if (month < 1 || month > 12) throw new SegmentRuleError("month must be between 1 and 12");
      return `${column} = ${bind(month)}`;
    }

    case "isActive":
    case "hasEmail":
    case "smsConsent":
    case "marketingConsent": {
      // `field` is read out before the check: all four of these rules declare
      // `value: boolean`, so inside the `if` TypeScript has narrowed `rule`
      // itself to `never` and cannot see `.field` any more.
      const field = rule.field;
      if (typeof rule.value !== "boolean") throw new SegmentRuleError(`${field} needs a boolean value`);
      return `${column} = ${bind(rule.value)}`;
    }

    case "city": {
      if (typeof rule.value !== "string" || rule.value.trim() === "") {
        throw new SegmentRuleError("city needs a non-empty value");
      }
      // ILIKE with the wildcards added *around the bound parameter*, so the
      // user's text stays a value. A user typing `%` matches literally more
      // rows — which is harmless — and can never end the string literal.
      return `${column} ILIKE ${bind(`%${rule.value.trim()}%`)}`;
    }

    default: {
      // Exhaustiveness: every member of the union is handled above, so `rule`
      // narrows to `never` here. Assigning it is what turns a *new* field
      // added to the union without a case into a compile error rather than a
      // rule silently compiling to nothing.
      const unhandled: never = rule;
      throw new SegmentRuleError(`Unhandled rule: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Compile a whole rule document into one boolean expression.
 *
 * An empty document compiles to `TRUE` («همهٔ مشتریان»).
 */
export function compileSegment(
  definition: SegmentDefinition,
  options: CompileOptions,
): CompiledSegment {
  if (!definition || typeof definition !== "object") {
    throw new SegmentRuleError("A segment definition must be an object");
  }
  if (!isIsoDate(options.anchorDate)) {
    throw new SegmentRuleError("anchorDate must be an ISO date (YYYY-MM-DD)");
  }

  // Reject a document with keys we do not understand, rather than ignoring
  // them. The failure mode this prevents is the dangerous one: an unrecognised
  // shape (say `{match, rules}` from a caller written against a different
  // spec) would contribute no clauses, and a document with no clauses compiles
  // to `TRUE` — "everyone". Silently widening an audience is exactly the
  // mistake this module exists to make impossible, so a malformed document
  // fails closed, the same way an unknown consent purpose does.
  for (const key of Object.keys(definition)) {
    if (key !== "all" && key !== "any") {
      throw new SegmentRuleError(`Unknown key in segment definition: ${key}`);
    }
  }

  const params: unknown[] = [];
  const offset = options.paramOffset ?? 0;
  const bind = (value: unknown) => {
    params.push(value);
    return `$${offset + params.length}`;
  };

  const all = (definition.all ?? []).map((rule) => compileRule(rule, bind, options));
  const any = (definition.any ?? []).map((rule) => compileRule(rule, bind, options));

  const clauses: string[] = [];
  if (all.length > 0) clauses.push(all.map((c) => `(${c})`).join(" AND "));
  if (any.length > 0) clauses.push(`(${any.map((c) => `(${c})`).join(" OR ")})`);

  return { sql: clauses.length === 0 ? "TRUE" : clauses.map((c) => `(${c})`).join(" AND "), params };
}

/** ISO calendar date, the repo's storage/wire convention. */
export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Validate a rule document coming off the wire, returning the problems rather
 * than throwing on the first one — a form should be able to show every invalid
 * row at once.
 */
export function validateSegmentDefinition(definition: unknown): string[] {
  const problems: string[] = [];
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    return ["تعریف بخش باید یک شیء باشد."];
  }
  const doc = definition as SegmentDefinition;
  for (const key of Object.keys(doc)) {
    if (key !== "all" && key !== "any") problems.push(`کلید ناشناخته در تعریف بخش: ${key}`);
  }
  const check = (rules: unknown, group: string) => {
    if (rules === undefined) return;
    if (!Array.isArray(rules)) {
      problems.push(`«${group}» باید فهرستی از شرط‌ها باشد.`);
      return;
    }
    rules.forEach((rule, index) => {
      try {
        // Compiled against a throwaway binder purely to run the validation the
        // compiler already performs — one definition of "valid", not two.
        compileRule(rule as SegmentRule, () => "$1", { anchorDate: "2024-01-01" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(`شرط ${index + 1} در «${group}»: ${message}`);
      }
    });
  };
  check(doc.all, "همهٔ شرط‌ها");
  check(doc.any, "هر یک از شرط‌ها");
  return problems;
}

/** How many rules a document holds — used for the «۳ شرط» chip on a segment card. */
export function countRules(definition: SegmentDefinition): number {
  return (definition.all?.length ?? 0) + (definition.any?.length ?? 0);
}

// ---------------------------------------------------------------------------
// Consent — enforced in the service, described here
// ---------------------------------------------------------------------------

/**
 * Why an audience is being resolved.
 *
 * This is the load-bearing argument of the whole CRM. A segment resolved for
 * *browsing* is every matching customer; a segment resolved to **send** an SMS
 * is only those who agreed to be sent one. Making it an explicit parameter with
 * no safe default is what stops the next caller — the messaging phase — from
 * forgetting, because there is nothing to forget: the type makes them choose.
 */
export type SegmentPurpose = "view" | "sms" | "email";

/**
 * The extra predicate a purpose imposes, over and above the segment's own
 * rules. Returned as SQL so it is applied *inside* the query — a filter applied
 * in a component is a filter the next caller does not have.
 *
 * - `sms` — needs consent **and** a number an SMS can actually reach; a
 *   landline with consent is still not an SMS audience.
 * - `email` — needs consent **and** a non-empty email.
 */
export function consentPredicate(purpose: SegmentPurpose): string {
  switch (purpose) {
    case "sms":
      return "c.sms_consent = true AND c.phone IS NOT NULL AND btrim(c.phone) <> ''";
    case "email":
      return "c.marketing_consent = true AND c.email IS NOT NULL AND btrim(c.email) <> ''";
    case "view":
      return "TRUE";
    default: {
      // An unknown purpose must never widen the audience. Failing closed here
      // means a typo produces an empty send, not an unconsented one.
      return "FALSE";
    }
  }
}

/** Whether a purpose is a *send* — the case consent applies to. */
export function isSendingPurpose(purpose: SegmentPurpose): boolean {
  return purpose === "sms" || purpose === "email";
}

// ---------------------------------------------------------------------------
// Presentation metadata — one place, so form/label/AI agree
// ---------------------------------------------------------------------------

export interface SegmentFieldMeta {
  field: SegmentField;
  label: string;
  /** Which operators the form offers for this field. */
  operators: readonly string[];
  /** What kind of value editor the form shows. */
  valueKind: "days" | "money" | "number" | "tags" | "month" | "boolean" | "text";
  /** One line of help under the row. */
  hint?: string;
}

/**
 * The segment builder's catalogue. The form renders from this, the segment
 * card describes a saved rule from this, and the assistant's tool description
 * lists these fields — so the three can never disagree about what a segment
 * can express.
 */
export const SEGMENT_FIELDS: readonly SegmentFieldMeta[] = [
  {
    field: "lastPurchaseAt",
    label: "آخرین خرید",
    operators: ["before", "after"],
    valueKind: "days",
    hint: "«قبل از» یعنی این تعداد روز است که خرید نکرده — مشتریان بدون هیچ خریدی هم در این گروه‌اند.",
  },
  {
    field: "firstPurchaseAt",
    label: "اولین خرید",
    operators: ["before", "after"],
    valueKind: "days",
    hint: "«بعد از» یعنی مشتری تازه است و اولین خریدش در این بازه بوده.",
  },
  { field: "totalSpentRial", label: "مجموع خرید", operators: ["gte", "lte"], valueKind: "money" },
  { field: "orderCount", label: "تعداد خرید", operators: ["gte", "lte"], valueKind: "number" },
  { field: "averageOrderRial", label: "میانگین هر خرید", operators: ["gte", "lte"], valueKind: "money" },
  { field: "tags", label: "برچسب‌ها", operators: ["hasAny", "hasAll", "hasNone"], valueKind: "tags" },
  {
    field: "birthdayMonth",
    label: "ماه تولد",
    operators: ["is"],
    valueKind: "month",
    hint: "ماه میلادیِ ذخیره‌شده در پروندهٔ مشتری.",
  },
  { field: "loyaltyPoints", label: "امتیاز وفاداری", operators: ["gte", "lte"], valueKind: "number" },
  { field: "isActive", label: "وضعیت فعال", operators: ["is"], valueKind: "boolean" },
  { field: "hasEmail", label: "ایمیل دارد", operators: ["is"], valueKind: "boolean" },
  { field: "smsConsent", label: "اجازهٔ پیامک", operators: ["is"], valueKind: "boolean" },
  { field: "marketingConsent", label: "اجازهٔ بازاریابی", operators: ["is"], valueKind: "boolean" },
  { field: "city", label: "نشانی شامل", operators: ["contains"], valueKind: "text" },
  { field: "createdAt", label: "تاریخ ثبت مشتری", operators: ["before", "after"], valueKind: "days" },
];

export const SEGMENT_OPERATOR_LABELS: Record<string, string> = {
  before: "قبل از (روز)",
  after: "در (روز) اخیر",
  gte: "حداقل",
  lte: "حداکثر",
  hasAny: "شامل یکی از",
  hasAll: "شامل همهٔ",
  hasNone: "شامل هیچ‌کدام از",
  is: "برابر است با",
  contains: "شامل",
};

export function segmentFieldMeta(field: SegmentField): SegmentFieldMeta {
  const found = SEGMENT_FIELDS.find((meta) => meta.field === field);
  if (!found) throw new SegmentRuleError(`Unknown segment field: ${field}`);
  return found;
}

/**
 * A one-line Persian description of a rule, for the segment card and for the
 * assistant's answer. Amounts are rendered by the caller (which knows the
 * business's Toman/Rial preference); this returns the raw Rial in the text's
 * place-holder position via `formatValue`.
 */
export function describeRule(rule: SegmentRule, formatMoney: (rial: number) => string): string {
  switch (rule.field) {
    case "lastPurchaseAt":
      return rule.op === "before"
        ? `بیش از ${rule.days} روز است خرید نکرده`
        : `در ${rule.days} روز اخیر خرید کرده`;
    case "firstPurchaseAt":
      return rule.op === "before"
        ? `اولین خریدش بیش از ${rule.days} روز پیش بوده`
        : `اولین خریدش در ${rule.days} روز اخیر بوده`;
    case "createdAt":
      return rule.op === "before"
        ? `بیش از ${rule.days} روز پیش ثبت شده`
        : `در ${rule.days} روز اخیر ثبت شده`;
    case "totalSpentRial":
      return `مجموع خرید ${rule.op === "gte" ? "حداقل" : "حداکثر"} ${formatMoney(rule.value)}`;
    case "averageOrderRial":
      return `میانگین خرید ${rule.op === "gte" ? "حداقل" : "حداکثر"} ${formatMoney(rule.value)}`;
    case "orderCount":
      return `${rule.op === "gte" ? "حداقل" : "حداکثر"} ${rule.value} خرید`;
    case "loyaltyPoints":
      return `${rule.op === "gte" ? "حداقل" : "حداکثر"} ${rule.value} امتیاز`;
    case "tags":
      return `${SEGMENT_OPERATOR_LABELS[rule.op]} برچسب‌های ${rule.values.join("، ")}`;
    case "birthdayMonth":
      return `ماه تولد برابر ${rule.month}`;
    case "isActive":
      return rule.value ? "مشتری فعال" : "مشتری غیرفعال";
    case "hasEmail":
      return rule.value ? "ایمیل دارد" : "ایمیل ندارد";
    case "smsConsent":
      return rule.value ? "اجازهٔ پیامک داده" : "اجازهٔ پیامک نداده";
    case "marketingConsent":
      return rule.value ? "اجازهٔ بازاریابی داده" : "اجازهٔ بازاریابی نداده";
    case "city":
      return `نشانی شامل «${rule.value}»`;
    default:
      return "";
  }
}

/** The whole document in one Persian line, for a card subtitle or an AI answer. */
export function describeSegment(
  definition: SegmentDefinition,
  formatMoney: (rial: number) => string,
): string {
  const all = (definition.all ?? []).map((r) => describeRule(r, formatMoney)).filter(Boolean);
  const any = (definition.any ?? []).map((r) => describeRule(r, formatMoney)).filter(Boolean);
  const parts: string[] = [];
  if (all.length > 0) parts.push(all.join(" و "));
  if (any.length > 0) parts.push(`(${any.join(" یا ")})`);
  return parts.length > 0 ? parts.join(" و ") : "همهٔ مشتریان";
}
