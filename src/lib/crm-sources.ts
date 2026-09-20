/**
 * Where a customer, lead or deal came from.
 *
 * ## Why a vocabulary and not free text
 *
 * "Where did this customer come from?" is the question every marketing budget
 * turns on, and it is unanswerable the moment the column is free text: one
 * business ends up with «اینستاگرام», «اینستا», «instagram» and «IG» as four
 * different sources, and no report can add them up. So the vocabulary is
 * closed, and anything outside it goes in `sourceDetail` — which *is* free
 * text, because «کمپین نوروز ۱۴۰۴» genuinely cannot be enumerated in advance.
 *
 * ## First-touch, never overwritten
 *
 * `acquisition_source` records how a person first arrived and is written
 * exactly once. A customer who found the shop on Instagram and later bought
 * online is still an Instagram acquisition; overwriting it with `woocommerce`
 * would silently reattribute every historical acquisition to whichever channel
 * touched the customer most recently, and the Instagram spend would look
 * worthless. `last_source` tracks the most recent touch separately, so both
 * questions have their own answer instead of one column giving a wrong answer
 * to both.
 */

/** The closed vocabulary. Order is the order the UI lists them in. */
export const CRM_SOURCES = [
  "pos",
  "woocommerce",
  "website_form",
  "instagram",
  "telegram",
  "whatsapp",
  "phone",
  "walk_in",
  "referral",
  "campaign",
  "event",
  "marketplace",
  "import",
  "manual",
  "other",
] as const;

export type CrmSource = (typeof CRM_SOURCES)[number];

export interface CrmSourceMeta {
  label: string;
  /** One line of help, shown where a person picks a source. */
  description: string;
  /**
   * True when the platform sets this itself. A person should not be offered
   * «فروشگاه آنلاین» in a dropdown — claiming it by hand would corrupt the
   * one number that says what the store is actually worth.
   */
  systemAssigned: boolean;
}

export const CRM_SOURCE_META: Record<CrmSource, CrmSourceMeta> = {
  pos: {
    label: "فروش حضوری",
    description: "اولین خرید از صندوق فروشگاه ثبت شده است.",
    systemAssigned: true,
  },
  woocommerce: {
    label: "فروشگاه آنلاین",
    description: "از طریق فروشگاه اینترنتی شناسایی شده است.",
    systemAssigned: true,
  },
  website_form: {
    label: "فرم وب‌سایت",
    description: "فرم تماس یا درخواست مشاوره در وب‌سایت پر کرده است.",
    systemAssigned: true,
  },
  instagram: {
    label: "اینستاگرام",
    description: "از طریق صفحهٔ اینستاگرام با شما آشنا شده است.",
    systemAssigned: false,
  },
  telegram: {
    label: "تلگرام",
    description: "از کانال یا پیام تلگرام آمده است.",
    systemAssigned: false,
  },
  whatsapp: {
    label: "واتس‌اپ",
    description: "از طریق واتس‌اپ تماس گرفته است.",
    systemAssigned: false,
  },
  phone: {
    label: "تماس تلفنی",
    description: "خودش تماس گرفته یا شمارهٔ شما را داشته است.",
    systemAssigned: false,
  },
  walk_in: {
    label: "مراجعهٔ حضوری",
    description: "بدون آشنایی قبلی وارد مغازه شده است.",
    systemAssigned: false,
  },
  referral: {
    label: "معرفی مشتری",
    description: "مشتری دیگری او را معرفی کرده است. نام معرف را در توضیح بنویسید.",
    systemAssigned: false,
  },
  campaign: {
    label: "کمپین تبلیغاتی",
    description: "از یک کمپین مشخص آمده است. نام کمپین را در توضیح بنویسید.",
    systemAssigned: false,
  },
  event: {
    label: "نمایشگاه یا رویداد",
    description: "در یک رویداد حضوری با کسب‌وکار آشنا شده است.",
    systemAssigned: false,
  },
  marketplace: {
    label: "بازارگاه آنلاین",
    description: "از دیجی‌کالا، باسلام یا مشابه آن آمده است.",
    systemAssigned: false,
  },
  import: {
    label: "ورود گروهی اطلاعات",
    description: "از فایل وارد شده است؛ منبع واقعی نامشخص است.",
    systemAssigned: true,
  },
  manual: {
    label: "ثبت دستی",
    description: "یکی از همکاران پرونده را دستی ساخته است.",
    systemAssigned: true,
  },
  other: {
    label: "سایر",
    description: "هیچ‌کدام. توضیح بنویسید تا بعداً قابل تفکیک باشد.",
    systemAssigned: false,
  },
};

export function isCrmSource(value: unknown): value is CrmSource {
  return typeof value === "string" && (CRM_SOURCES as readonly string[]).includes(value);
}

/**
 * Coerce a stored value into the vocabulary for display.
 *
 * Never throws and never discards: a row written before this vocabulary
 * existed, or by an integration using its own word, still has to render. It
 * falls back to `other` for grouping while the original string stays in the
 * column — losing it would destroy the only evidence of what the source
 * actually was.
 */
export function normaliseSource(value: string | null | undefined): CrmSource {
  if (!value) return "manual";
  const trimmed = value.trim().toLowerCase();
  if (isCrmSource(trimmed)) return trimmed;
  // A few aliases that predate the vocabulary, so historical rows group with
  // the channel they actually mean rather than all landing in «سایر».
  const aliases: Record<string, CrmSource> = {
    woo: "woocommerce",
    wordpress: "woocommerce",
    online: "woocommerce",
    shop: "pos",
    store: "pos",
    counter: "pos",
    sms: "campaign",
    ig: "instagram",
  };
  return aliases[trimmed] ?? "other";
}

/** The label for any stored value, including ones outside the vocabulary. */
export function sourceLabel(value: string | null | undefined): string {
  if (!value?.trim()) return CRM_SOURCE_META.manual.label;
  const normalised = normaliseSource(value);
  // An unrecognised value shows itself rather than «سایر»: the raw string is
  // more informative to the person reading it than the bucket it fell into.
  if (normalised === "other" && value.trim().toLowerCase() !== "other") return value.trim();
  return CRM_SOURCE_META[normalised].label;
}

/** The sources a person may choose. Excludes the ones the platform assigns. */
export function selectableSources(): { value: CrmSource; label: string; description: string }[] {
  return CRM_SOURCES.filter((source) => !CRM_SOURCE_META[source].systemAssigned).map((source) => ({
    value: source,
    label: CRM_SOURCE_META[source].label,
    description: CRM_SOURCE_META[source].description,
  }));
}

/**
 * Decide what to write for a party's acquisition columns.
 *
 * Pure, and the single place the first-touch rule is expressed, so no caller
 * can quietly overwrite an acquisition by passing a fresher value. Returns
 * what to set; the caller does the UPDATE.
 */
export function resolveAcquisition(
  current: { source: string | null; detail: string | null; at: string | null },
  incoming: { source: CrmSource; detail?: string; at?: string },
): {
  /** Null when the existing acquisition must be preserved. */
  acquisitionSource: CrmSource | null;
  acquisitionDetail: string | null;
  acquisitionAt: string | null;
  /** Always written — the most recent touch is a different question. */
  lastSource: CrmSource;
} {
  const alreadyAcquired = Boolean(current.source?.trim());
  return {
    acquisitionSource: alreadyAcquired ? null : incoming.source,
    acquisitionDetail: alreadyAcquired ? null : (incoming.detail?.trim() ?? ""),
    acquisitionAt: alreadyAcquired ? null : (incoming.at ?? new Date().toISOString()),
    lastSource: incoming.source,
  };
}
