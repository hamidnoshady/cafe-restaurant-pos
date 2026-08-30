/**
 * RFM scoring and customer lifecycle — pure, framework-free.
 *
 * A CRM that can only *list* customers makes the owner do the analysis. The
 * question behind «به کی پیام بدهم؟» is always the same three facts — how
 * recently someone bought (Recency), how often (Frequency), how much
 * (Monetary) — and the standard answer is RFM. This file is that answer,
 * kept pure so it is unit-tested directly and so the dashboard, the segment
 * preview and the assistant all score a customer identically.
 *
 * ## Two decisions worth stating
 *
 * **Quintiles over the business's own customers, not absolute thresholds.** A
 * gold shop's «خرید زیاد» is two orders of magnitude above a café's. Scoring
 * against fixed Rial bands would label every café customer "low value" and
 * every jeweller's "high". So R/F/M are each scored 1-5 by *rank within this
 * business's own population*, which makes the segments mean the same thing in
 * both trades — and makes them comparable across a business's own branches.
 *
 * **Recency is measured against the branch's business date**, passed in by the
 * caller, never `Date.now()` here. A café trading 18:00-03:00 files a 01:30
 * order under the previous business day; scoring it against the calendar date
 * would make yesterday's customer look like today's for a few hours each
 * night. Same rule as `segments.ts`.
 *
 * The lifecycle stages are the conventional RFM cells collapsed into the ten
 * an owner can act on, each with a Persian label and a one-line recommendation
 * — because a segment named "champions" with no suggested action is a fact,
 * not a tool.
 */

/** One customer's raw history, as the aggregate query returns it. */
export interface CustomerRfmInput {
  customerId: string;
  name: string;
  /** ISO date of the most recent purchase; null when they have never bought. */
  lastPurchaseDate: string | null;
  orderCount: number;
  /** Lifetime spend, integer Rial. */
  totalSpentRial: number;
}

export interface RfmScore {
  customerId: string;
  name: string;
  /** Days between the anchor date and the last purchase; null when never. */
  recencyDays: number | null;
  orderCount: number;
  totalSpentRial: number;
  /** 1-5, 5 = bought most recently. A customer who never bought scores 1. */
  recency: number;
  /** 1-5, 5 = bought most often. */
  frequency: number;
  /** 1-5, 5 = spent most. */
  monetary: number;
  /** The three digits as one string, e.g. "545" — the conventional RFM cell. */
  cell: string;
  /** Sum of the three, 3-15 — a single sortable number for a leaderboard. */
  total: number;
  stage: LifecycleStage;
}

export type LifecycleStage =
  | "champion"
  | "loyal"
  | "potential_loyalist"
  | "new"
  | "promising"
  | "needs_attention"
  | "about_to_sleep"
  | "at_risk"
  | "cant_lose"
  | "hibernating"
  | "lost"
  | "never_purchased";

export interface LifecycleMeta {
  key: LifecycleStage;
  label: string;
  /** What this group is, in the owner's words. */
  description: string;
  /** What to actually do about them — the reason the stage is useful. */
  action: string;
  /** Badge tone, matching `StatusBadge`'s four tones. */
  tone: "active" | "positive" | "neutral" | "danger";
}

/**
 * The stages, in the order a dashboard should read them: best first, then the
 * ones needing action, then the ones effectively gone.
 */
export const LIFECYCLE_STAGES: Record<LifecycleStage, LifecycleMeta> = {
  champion: {
    key: "champion",
    label: "مشتریان طلایی",
    description: "تازه خرید کرده‌اند، زیاد می‌آیند و بیشترین خرید را دارند.",
    action: "پاداش بده و نظرشان را بپرس؛ اینها معرف‌های طبیعی کسب‌وکارند.",
    tone: "positive",
  },
  loyal: {
    key: "loyal",
    label: "مشتریان وفادار",
    description: "مرتب خرید می‌کنند و مبلغ خوبی می‌پردازند.",
    action: "پیشنهاد ویژه و دسترسی زودهنگام؛ نگه‌داشتنشان ارزان‌تر از جذب تازه است.",
    tone: "positive",
  },
  potential_loyalist: {
    key: "potential_loyalist",
    label: "در آستانهٔ وفاداری",
    description: "اخیراً چند بار خرید کرده‌اند.",
    action: "عضویت در باشگاه مشتریان را پیشنهاد بده؛ یک قدم تا وفاداری فاصله دارند.",
    tone: "active",
  },
  new: {
    key: "new",
    label: "مشتریان تازه",
    description: "همین اواخر اولین خریدشان را کرده‌اند.",
    action: "خوش‌آمد بگو و خرید دوم را تشویق کن؛ خرید دوم است که مشتری می‌سازد.",
    tone: "active",
  },
  promising: {
    key: "promising",
    label: "امیدبخش",
    description: "خرید تازه دارند اما هنوز کم‌تعداد و کم‌مبلغ‌اند.",
    action: "با یک پیشنهاد کوچک برگردانشان.",
    tone: "active",
  },
  needs_attention: {
    key: "needs_attention",
    label: "نیازمند توجه",
    description: "خرید خوبی داشته‌اند اما فاصله افتاده است.",
    action: "پیشنهاد محدود به زمان بفرست؛ هنوز در دسترس‌اند.",
    tone: "active",
  },
  about_to_sleep: {
    key: "about_to_sleep",
    label: "در حال فراموشی",
    description: "مدتی است نیامده‌اند و تعدادشان هم زیاد نبوده.",
    action: "یادآوری ساده؛ هزینهٔ تلاش را پایین نگه دار.",
    tone: "neutral",
  },
  at_risk: {
    key: "at_risk",
    label: "در معرض ریزش",
    description: "قبلاً خوب خرید می‌کردند و مدتی است خبری نیست.",
    action: "تماس شخصی یا تخفیف بازگشت؛ ارزششان توجیه می‌کند.",
    tone: "danger",
  },
  cant_lose: {
    key: "cant_lose",
    label: "نباید از دست بروند",
    description: "بیشترین خرید تاریخی را داشته‌اند و حالا غایب‌اند.",
    action: "بالاترین اولویت تماس؛ از دست دادنشان گران‌ترین ریزش است.",
    tone: "danger",
  },
  hibernating: {
    key: "hibernating",
    label: "خفته",
    description: "خیلی وقت است نیامده‌اند و خریدشان هم کم بوده.",
    action: "فقط در کمپین‌های گسترده و کم‌هزینه.",
    tone: "neutral",
  },
  lost: {
    key: "lost",
    label: "از دست رفته",
    description: "کمترین امتیاز در هر سه شاخص.",
    action: "تلاش بازگشت را محدود کن؛ روی مشتریان دیگر سرمایه‌گذاری کن.",
    tone: "neutral",
  },
  never_purchased: {
    key: "never_purchased",
    label: "بدون خرید",
    description: "در پرونده ثبت شده‌اند اما هنوز خریدی نکرده‌اند.",
    action: "اولین خرید را با یک پیشنهاد شروع‌کننده تشویق کن.",
    tone: "neutral",
  },
};

export const LIFECYCLE_ORDER: readonly LifecycleStage[] = [
  "champion",
  "loyal",
  "potential_loyalist",
  "new",
  "promising",
  "needs_attention",
  "at_risk",
  "cant_lose",
  "about_to_sleep",
  "hibernating",
  "lost",
  "never_purchased",
];

/** Whole days between two ISO dates (UTC arithmetic — both are calendar dates, no zone involved). */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * Score `values` 1-5 by their rank within the population.
 *
 * Ties get the same score — two customers with three orders each must not land
 * in different frequency bands, or the same history would tell two stories.
 * That is why this is rank-with-ties rather than a naive index split, and it is
 * also why a population where everyone is identical scores everyone 3
 * (the middle) rather than spreading them arbitrarily.
 *
 * `ascending` = higher value scores higher (frequency, monetary). Recency is
 * scored descending, because *fewer* days since the last purchase is better.
 */
export function quintileScores(values: number[], ascending = true): number[] {
  const n = values.length;
  if (n === 0) return [];
  const sorted = [...new Set(values)].sort((a, b) => (ascending ? a - b : b - a));
  if (sorted.length === 1) return values.map(() => 3);

  // Rank each distinct value 0..(k-1), then map that rank onto 1..5. Using the
  // distinct-value rank rather than the row index is what makes a population
  // of "mostly ones" still separate its rare big spenders into band 5.
  const rankOf = new Map<number, number>();
  sorted.forEach((value, index) => rankOf.set(value, index));
  const lastRank = sorted.length - 1;

  return values.map((value) => {
    const rank = rankOf.get(value) ?? 0;
    const score = Math.floor((rank / lastRank) * 5) + 1;
    return Math.min(5, Math.max(1, score));
  });
}

/**
 * Map an R/F/M triple onto an actionable stage.
 *
 * These are the conventional RFM cells, collapsed. The order of the checks is
 * the priority: "can't lose" is tested before "at risk" because a lapsed
 * top-spender needs a different response from a lapsed regular, and the more
 * urgent label must win.
 */
export function lifecycleStage(recency: number, frequency: number, monetary: number): LifecycleStage {
  const fm = Math.round((frequency + monetary) / 2);

  if (recency >= 4 && fm >= 4) return "champion";
  if (recency >= 3 && fm >= 4) return "loyal";
  if (recency >= 4 && fm >= 2) return "potential_loyalist";
  if (recency >= 4 && fm < 2) return "new";
  if (recency === 3 && fm >= 2) return "promising";
  if (recency === 3 && fm < 2) return "about_to_sleep";
  if (recency === 2 && fm >= 4) return "cant_lose";
  if (recency === 2 && fm >= 2) return "needs_attention";
  if (recency <= 2 && fm >= 4) return "at_risk";
  if (recency <= 2 && fm >= 2) return "hibernating";
  return "lost";
}

/**
 * Score a whole population at once.
 *
 * A population, not a customer: the quintiles only exist relative to everyone
 * else, so scoring one customer in isolation is not a meaningful operation and
 * this module deliberately does not offer it.
 *
 * Customers with no purchase at all are scored (so they appear in the file with
 * a stage) but are excluded from the quintile population — including them would
 * drag every band and make a business with many walk-in records look like it
 * had lost its customers.
 */
export function scorePopulation(rows: CustomerRfmInput[], anchorDate: string): RfmScore[] {
  const purchasers = rows.filter((row) => row.lastPurchaseDate !== null && row.orderCount > 0);
  const never = rows.filter((row) => row.lastPurchaseDate === null || row.orderCount === 0);

  const recencyDays = purchasers.map((row) => daysBetween(row.lastPurchaseDate!, anchorDate));
  // Recency: fewer days is better, so rank descending.
  const recencyScores = quintileScores(recencyDays, false);
  const frequencyScores = quintileScores(purchasers.map((row) => row.orderCount), true);
  const monetaryScores = quintileScores(purchasers.map((row) => row.totalSpentRial), true);

  const scored: RfmScore[] = purchasers.map((row, index) => {
    const recency = recencyScores[index] ?? 1;
    const frequency = frequencyScores[index] ?? 1;
    const monetary = monetaryScores[index] ?? 1;
    return {
      customerId: row.customerId,
      name: row.name,
      recencyDays: recencyDays[index],
      orderCount: row.orderCount,
      totalSpentRial: row.totalSpentRial,
      recency,
      frequency,
      monetary,
      cell: `${recency}${frequency}${monetary}`,
      total: recency + frequency + monetary,
      stage: lifecycleStage(recency, frequency, monetary),
    };
  });

  for (const row of never) {
    scored.push({
      customerId: row.customerId,
      name: row.name,
      recencyDays: null,
      orderCount: 0,
      totalSpentRial: 0,
      recency: 1,
      frequency: 1,
      monetary: 1,
      cell: "111",
      total: 3,
      stage: "never_purchased",
    });
  }

  return scored;
}

/** How many customers sit in each stage — the dashboard's distribution card. */
export function stageDistribution(scores: RfmScore[]): { stage: LifecycleStage; count: number; valueRial: number }[] {
  const counts = new Map<LifecycleStage, { count: number; valueRial: number }>();
  for (const score of scores) {
    const entry = counts.get(score.stage) ?? { count: 0, valueRial: 0 };
    entry.count += 1;
    entry.valueRial += score.totalSpentRial;
    counts.set(score.stage, entry);
  }
  return LIFECYCLE_ORDER.filter((stage) => counts.has(stage)).map((stage) => ({
    stage,
    count: counts.get(stage)!.count,
    valueRial: counts.get(stage)!.valueRial,
  }));
}

// ---------------------------------------------------------------------------
// Retention, churn and lifetime value
// ---------------------------------------------------------------------------

export interface RetentionInput {
  /** Customers who bought in the earlier window. */
  priorCustomerIds: string[];
  /** Customers who bought in the later window. */
  currentCustomerIds: string[];
}

export interface RetentionResult {
  priorCount: number;
  currentCount: number;
  /** How many of the prior window's customers came back in the current one. */
  retainedCount: number;
  /** Prior-window customers who did not return. */
  churnedCount: number;
  /** Current-window customers who were not in the prior window. */
  newCount: number;
  /** 0-100, rounded to one decimal. Zero prior customers yields 0, not NaN. */
  retentionRate: number;
  churnRate: number;
}

/**
 * Retention between two windows, by customer identity.
 *
 * Set arithmetic rather than a ratio of counts: "we had 100 last quarter and
 * 100 this quarter" says nothing about whether they are the *same* hundred,
 * which is the only version of the question worth asking.
 */
export function retentionBetween(input: RetentionInput): RetentionResult {
  const prior = new Set(input.priorCustomerIds);
  const current = new Set(input.currentCustomerIds);
  let retained = 0;
  for (const id of prior) if (current.has(id)) retained += 1;
  const priorCount = prior.size;
  const churned = priorCount - retained;
  let fresh = 0;
  for (const id of current) if (!prior.has(id)) fresh += 1;

  const rate = (part: number) => (priorCount === 0 ? 0 : Math.round((part / priorCount) * 1000) / 10);

  return {
    priorCount,
    currentCount: current.size,
    retainedCount: retained,
    churnedCount: churned,
    newCount: fresh,
    retentionRate: rate(retained),
    churnRate: rate(churned),
  };
}

export interface LifetimeValueInput {
  totalSpentRial: number;
  orderCount: number;
  /** Days between first and last purchase; 0 for a one-visit customer. */
  activeDays: number;
}

export interface LifetimeValueResult {
  /** Realised spend to date — a fact, not a projection. */
  historicRial: number;
  averageOrderRial: number;
  /** Average days between purchases; null when there has been only one. */
  purchaseIntervalDays: number | null;
  /** Estimated orders per year at the observed cadence; null when unknowable. */
  annualFrequency: number | null;
  /** Projected 12-month value at the observed cadence. Null when there is no cadence yet. */
  projectedAnnualRial: number | null;
}

/**
 * Lifetime value, split into what is **known** and what is **projected**.
 *
 * Keeping them apart is the point. `historicRial` is money that actually came
 * through the till and can be reconciled against the ledger; the projection is
 * arithmetic on an observed cadence and is labelled as an estimate wherever it
 * is shown. Merging them into one "LTV" number is how a marketing screen ends
 * up disagreeing with the books.
 *
 * A customer with one order has no interval, so no projection is offered —
 * null rather than a guess extrapolated from a single point.
 */
export function lifetimeValue(input: LifetimeValueInput): LifetimeValueResult {
  const { totalSpentRial, orderCount, activeDays } = input;
  const averageOrderRial = orderCount > 0 ? Math.round(totalSpentRial / orderCount) : 0;

  if (orderCount < 2 || activeDays <= 0) {
    return {
      historicRial: totalSpentRial,
      averageOrderRial,
      purchaseIntervalDays: null,
      annualFrequency: null,
      projectedAnnualRial: null,
    };
  }

  const purchaseIntervalDays = Math.round((activeDays / (orderCount - 1)) * 10) / 10;
  const annualFrequency =
    purchaseIntervalDays > 0 ? Math.round((365 / purchaseIntervalDays) * 10) / 10 : null;
  const projectedAnnualRial =
    annualFrequency !== null ? Math.round(annualFrequency * averageOrderRial) : null;

  return {
    historicRial: totalSpentRial,
    averageOrderRial,
    purchaseIntervalDays,
    annualFrequency,
    projectedAnnualRial,
  };
}
