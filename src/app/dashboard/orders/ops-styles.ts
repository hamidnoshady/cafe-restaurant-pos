/**
 * The operations design language, as class strings, for the order screens.
 *
 * The floor-facing app (dashboard overview, POS, KDS, orders queue) is drawn
 * in one palette — cream #FCFCFA canvas, white cards on #EAE8E2 hairlines, the
 * amber #E9A11B accent, #E5CCC5/#9E4437 for anything destructive — with touch
 * targets no smaller than 44px and a consistent focus ring. Those recipes were
 * copy-pasted per file, which is how the order detail drifted into a different
 * look entirely. Naming them once means a control here cannot fall out of step
 * with its siblings.
 *
 * Same idea as `inputClass` in ../ui, one level up: whole controls, not one
 * element.
 */

/** The amber focus ring every interactive element in this language wears. */
export const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45";

/** A white surface panel. */
export const CARD =
  "rounded-2xl border border-[#EAE8E2] bg-white shadow-[0_1px_2px_rgba(37,37,34,0.03)]";

/** The one amber call to action on a surface — full width by default. */
export const PRIMARY_BUTTON = `flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#E9A11B] px-4 text-sm font-bold text-[#252522] transition duration-200 hover:bg-[#DB9612] ${FOCUS} active:scale-[0.98] disabled:opacity-55 motion-reduce:transition-none`;

/** Everything else: outlined, white, quiet. */
export const SECONDARY_BUTTON = `inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[#EAE8E2] bg-white px-3 text-sm font-semibold text-[#5E5B55] transition-colors hover:bg-[#FCFCFA] ${FOCUS} active:scale-[0.98] disabled:opacity-55`;

/** Voiding, removing, reversing — outlined rather than solid, so it is never the loudest thing on screen. */
export const DANGER_BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[#E5CCC5] bg-white px-3 text-sm font-semibold text-[#9E4437] transition-colors hover:bg-[#FFF7F4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D95757]/35 active:scale-[0.98] disabled:opacity-55";

/** Text/number inputs and SearchableSelect triggers. */
export const OPS_INPUT =
  "min-h-12 w-full min-w-0 rounded-xl border border-[#EAE8E2] bg-[#FCFCFA] px-3 text-sm text-[#252522] outline-none placeholder:text-[#8D8A82] focus-visible:border-[#E9A11B] focus-visible:ring-2 focus-visible:ring-[#E9A11B]/25";

/** One square of a −/qty/+ stepper. */
export const STEPPER_BUTTON = `flex size-11 shrink-0 items-center justify-center rounded-xl border border-[#EAE8E2] bg-white text-[#5E5B55] transition-colors hover:bg-[#FCFCFA] ${FOCUS} active:scale-[0.95] disabled:opacity-40 motion-reduce:transition-none`;
