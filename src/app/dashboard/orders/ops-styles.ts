/**
 * The operations design language, as class strings, for the order screens.
 *
 * The floor-facing app (dashboard overview, POS, KDS, orders queue) is drawn
 * in one palette — the warm canvas and `bg-card` surfaces on `border-border`
 * hairlines, the amber accent, the `destructive` token for anything that
 * removes or reverses — with touch targets no smaller than 44px and a
 * consistent focus ring. Those recipes were
 * copy-pasted per file, which is how the order detail drifted into a different
 * look entirely. Naming them once means a control here cannot fall out of step
 * with its siblings.
 *
 * Same idea as `inputClass` in ../ui, one level up: whole controls, not one
 * element.
 */
import { cardClass } from "../page-chrome";

/** The amber focus ring every interactive element in this language wears. */
export const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45";

/**
 * A white surface panel — the shared card skin, so an operations card and an
 * accounting section card are literally the same classes.
 */
export const CARD = cardClass;

/** The one amber call to action on a surface — full width by default. */
export const PRIMARY_BUTTON = `flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-amber-500 dark:bg-amber-400 px-4 text-sm font-bold text-amber-950 transition duration-200 hover:bg-amber-600 dark:hover:bg-amber-300 ${FOCUS} active:scale-[0.98] disabled:opacity-55 motion-reduce:transition-none`;

/** Everything else: outlined, white, quiet. */
export const SECONDARY_BUTTON = `inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-border/80 bg-card px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted ${FOCUS} active:scale-[0.98] disabled:opacity-55`;

/** Voiding, removing, reversing — outlined rather than solid, so it is never the loudest thing on screen. */
export const DANGER_BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-destructive/30 bg-card px-3 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/35 active:scale-[0.98] disabled:opacity-55";

/** Text/number inputs and SearchableSelect triggers. */
export const OPS_INPUT =
  "min-h-12 w-full min-w-0 rounded-xl border border-border/80 bg-muted px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-2 focus-visible:ring-amber-500/25 dark:focus-visible:ring-amber-400/45";

/** One square of a −/qty/+ stepper. */
export const STEPPER_BUTTON = `flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/80 bg-card text-muted-foreground transition-colors hover:bg-muted ${FOCUS} active:scale-[0.95] disabled:opacity-40 motion-reduce:transition-none`;
