"use client";

import {
  formatModifierDelta,
  sumModifierDeltas,
  type DisplayModifier,
} from "@/lib/modifier-display";

/**
 * Add-ons are shown against two different surfaces: the amber cash-desk
 * surfaces (POS cart, review dialog, open-orders panel) and the turquoise
 * document surfaces (order page, waiter panel). One palette on both would read
 * as a foreign element on whichever surface it didn't match, so the tone picks
 * the accent and everything else about the chip stays identical.
 */
export type ModifierTone = "amber" | "brand";

export const MODIFIER_TONE: Record<
  ModifierTone,
  {
    /** Unselected/neutral chip — how an already-chosen add-on reads in a list. */
    chip: string;
    /** The money inside a chip. */
    chipPrice: string;
    /** The «افزودنی‌ها» caption above the chips. */
    caption: string;
    /** A pickable option in the picker, unselected. */
    option: string;
    /** …and selected. */
    optionSelected: string;
    /** Accent for standalone amounts (unit price, group rule badges). */
    accent: string;
    /** Tinted surface for a summary block. */
    surface: string;
    /** The confirming call-to-action, so it matches the surface that opened the dialog. */
    cta: string;
  }
> = {
  amber: {
    chip: "border-amber-200 bg-amber-50 text-stone-600",
    chipPrice: "text-amber-700",
    caption: "text-stone-400",
    option:
      "border-stone-200/80 bg-card text-stone-600 hover:border-amber-200 hover:bg-amber-50",
    optionSelected: "border-amber-500 bg-amber-100 text-amber-700",
    accent: "text-amber-700",
    surface: "border-amber-200/60 bg-amber-50",
    cta: "bg-amber-500 text-stone-950 hover:bg-amber-500 focus-visible:ring-amber-500/45",
  },
  brand: {
    chip: "border-primary/25 bg-primary/5 text-foreground",
    chipPrice: "text-primary",
    caption: "text-muted-foreground",
    option:
      "border-input bg-background text-muted-foreground hover:border-primary/50 hover:bg-primary/5 hover:text-foreground",
    optionSelected: "border-primary bg-primary/10 text-primary",
    accent: "text-primary",
    surface: "border-primary/20 bg-primary/5",
    cta: "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/45",
  },
};

/**
 * The one way an order line's add-ons are rendered on screen: a captioned row
 * of chips, each carrying its own price. Callers pass the line's add-ons; an
 * empty list renders nothing so a plain line stays visually plain.
 */
export function ModifierBadges({
  modifiers,
  tone = "amber",
  showCaption = true,
  showPrices = true,
  className = "",
}: {
  modifiers: DisplayModifier[];
  tone?: ModifierTone;
  showCaption?: boolean;
  showPrices?: boolean;
  className?: string;
}) {
  if (modifiers.length === 0) return null;
  const palette = MODIFIER_TONE[tone];
  const total = sumModifierDeltas(modifiers.map((m) => m.priceDelta));

  return (
    <div className={className}>
      {showCaption ? (
        <p
          className={`mb-1 text-[11px] font-semibold ${palette.caption}`}
          aria-hidden="true"
        >
          افزودنی‌ها
          {showPrices && total !== 0
            ? ` (${formatModifierDelta(total)} روی هر واحد)`
            : ""}
        </p>
      ) : null}
      <ul className="flex flex-wrap gap-1.5">
        {modifiers.map((modifier, index) => (
          <li
            key={`${modifier.name}-${index}`}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-semibold leading-5 ${palette.chip}`}
          >
            <span className="truncate">{modifier.name}</span>
            {showPrices ? (
              <span className={`shrink-0 font-bold ${palette.chipPrice}`}>
                {formatModifierDelta(modifier.priceDelta)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
