/**
 * The per-branch identifying colour (migration 0149).
 *
 * A multi-branch business needs one glance to answer «الان در کدام شعبه‌ام؟».
 * The switcher in the shell header carries this colour so the answer is
 * pre-verbal: you notice you are in the wrong branch before you have read
 * anything. It is deliberately *not* the primary/brand colour — the brand is
 * the business, which does not change as you move between its branches, and
 * repainting the primary per branch would make the product look like a
 * different app in each one. This is a marker beside the control, in the shape
 * the codebase already uses for state (`StatusBadge`'s tinted pills).
 *
 * Framework-free so it can be unit tested; the classes are written out in full
 * because Tailwind only compiles class names it can see in the source, and a
 * template literal like `bg-${key}-500` compiles to nothing.
 */

/**
 * The palette, in assignment order (0149's CHECK lists the same set).
 *
 * The *order* is load-bearing, not alphabetical: `nextBranchColor` walks it,
 * so the first N entries are what a business with N branches actually sees.
 * They are arranged so the early ones are far apart in hue — the first six
 * stay at least 53° apart, and the two closest pairs in the set
 * (emerald/teal at 20°, amber/orange at 22°) are pushed to positions 7 and 8,
 * where a business is already past the point of identifying branches by
 * colour alone. Reordering this list to taste will quietly make two-branch
 * and three-branch businesses harder to read, which is most of them.
 *
 * `slate` leads because it is the column default and the near-achromatic
 * entry (chroma 0.046): a single-branch business gets a neutral control
 * rather than an arbitrary colour implying a distinction it does not have.
 */
export const BRANCH_COLORS = [
  "slate",
  "rose",
  "amber",
  "emerald",
  "sky",
  "violet",
  "teal",
  "orange",
] as const;

export type BranchColor = (typeof BRANCH_COLORS)[number];

/** The column default, and what an unrecognised value falls back to. */
export const DEFAULT_BRANCH_COLOR: BranchColor = "slate";

export function isBranchColor(value: unknown): value is BranchColor {
  return typeof value === "string" && (BRANCH_COLORS as readonly string[]).includes(value);
}

/**
 * Narrows anything read from the database or a request body to a usable
 * colour. A row written before 0149's CHECK, or a body from an older client,
 * must paint *something* rather than leave an unstyled control.
 */
export function toBranchColor(value: unknown): BranchColor {
  return isBranchColor(value) ? value : DEFAULT_BRANCH_COLOR;
}

interface BranchColorStyle {
  /** Persian name, for the picker and for screen readers. */
  label: string;
  /** A filled dot/chip — the marker on the switcher trigger. */
  dot: string;
  /** A tinted surface + text, for the trigger itself and the active row. */
  surface: string;
  /** A 2-3px edge, for the strip that runs along the top of the shell. */
  bar: string;
  /** Focus/selected ring in the picker. */
  ring: string;
}

/**
 * Each entry carries a light and a dark value chosen together. The dark
 * variants are deliberately less saturated: the same 500-weight that reads as
 * a confident marker on white glares on the dark surface.
 */
const STYLES: Record<BranchColor, BranchColorStyle> = {
  slate: {
    label: "خاکستری",
    dot: "bg-slate-500 dark:bg-slate-400",
    surface:
      "bg-slate-100 text-slate-900 border-slate-300 dark:bg-slate-500/20 dark:text-slate-100 dark:border-slate-400/40",
    bar: "bg-slate-500 dark:bg-slate-400",
    ring: "ring-slate-500 dark:ring-slate-400",
  },
  rose: {
    label: "صورتی",
    dot: "bg-rose-500 dark:bg-rose-400",
    surface:
      "bg-rose-100 text-rose-950 border-rose-300 dark:bg-rose-500/20 dark:text-rose-100 dark:border-rose-400/40",
    bar: "bg-rose-500 dark:bg-rose-400",
    ring: "ring-rose-500 dark:ring-rose-400",
  },
  amber: {
    label: "کهربایی",
    dot: "bg-amber-500 dark:bg-amber-400",
    surface:
      "bg-amber-100 text-amber-950 border-amber-300 dark:bg-amber-500/20 dark:text-amber-100 dark:border-amber-400/40",
    bar: "bg-amber-500 dark:bg-amber-400",
    ring: "ring-amber-500 dark:ring-amber-400",
  },
  emerald: {
    label: "سبز",
    dot: "bg-emerald-500 dark:bg-emerald-400",
    surface:
      "bg-emerald-100 text-emerald-950 border-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-100 dark:border-emerald-400/40",
    bar: "bg-emerald-500 dark:bg-emerald-400",
    ring: "ring-emerald-500 dark:ring-emerald-400",
  },
  sky: {
    label: "آبی",
    dot: "bg-sky-500 dark:bg-sky-400",
    surface:
      "bg-sky-100 text-sky-950 border-sky-300 dark:bg-sky-500/20 dark:text-sky-100 dark:border-sky-400/40",
    bar: "bg-sky-500 dark:bg-sky-400",
    ring: "ring-sky-500 dark:ring-sky-400",
  },
  violet: {
    label: "بنفش",
    dot: "bg-violet-500 dark:bg-violet-400",
    surface:
      "bg-violet-100 text-violet-950 border-violet-300 dark:bg-violet-500/20 dark:text-violet-100 dark:border-violet-400/40",
    bar: "bg-violet-500 dark:bg-violet-400",
    ring: "ring-violet-500 dark:ring-violet-400",
  },
  teal: {
    label: "فیروزه‌ای",
    dot: "bg-teal-500 dark:bg-teal-400",
    surface:
      "bg-teal-100 text-teal-950 border-teal-300 dark:bg-teal-500/20 dark:text-teal-100 dark:border-teal-400/40",
    bar: "bg-teal-500 dark:bg-teal-400",
    ring: "ring-teal-500 dark:ring-teal-400",
  },
  orange: {
    label: "نارنجی",
    dot: "bg-orange-500 dark:bg-orange-400",
    surface:
      "bg-orange-100 text-orange-950 border-orange-300 dark:bg-orange-500/20 dark:text-orange-100 dark:border-orange-400/40",
    bar: "bg-orange-500 dark:bg-orange-400",
    ring: "ring-orange-500 dark:ring-orange-400",
  },
};

export function branchColorStyle(value: unknown): BranchColorStyle {
  return STYLES[toBranchColor(value)];
}

export function branchColorLabel(value: unknown): string {
  return branchColorStyle(value).label;
}

/**
 * The colour a new branch gets when the owner does not choose one.
 *
 * Picks the first palette entry none of the existing branches uses, so a
 * business that never opens the picker still ends up with branches it can tell
 * apart. Once every colour is taken it wraps by count — eight visually
 * distinct branches is already past the point where colour alone is the
 * identifier, and repeating one is better than refusing to create the branch.
 */
export function nextBranchColor(taken: readonly unknown[]): BranchColor {
  const used = new Set(taken.filter(isBranchColor));
  const free = BRANCH_COLORS.find((color) => !used.has(color));
  return free ?? BRANCH_COLORS[taken.length % BRANCH_COLORS.length];
}
