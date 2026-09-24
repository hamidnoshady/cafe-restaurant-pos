import type { ReactNode } from "react";
import { CardEyebrow } from "@/app/dashboard/page-chrome";

/**
 * The CRM's standard card heading — the amber kicker line («رفتار خرید»,
 * «میز خدمت», «حریم و رضایت») over the section's own title.
 *
 * Every CRM section card opened with the same two lines retyped, and they had
 * already drifted once (one failure-state card coloured the title with a raw
 * stone palette class while its loaded twin said `text-foreground`). The shape
 * lives here once, built on the platform's own `CardEyebrow`, so the next
 * section cannot drift from the last one.
 *
 * The `<h2>` is this component's to own: `SectionCard` only wraps a ReactNode
 * title in a plain `<div>` (a nested heading would be invalid markup — see
 * the note in `page-chrome.tsx`), so the caller hands over the heading and
 * nothing here re-wraps it.
 */
export function CrmCardHeading({
  kicker,
  title,
}: {
  kicker: string;
  title: ReactNode;
}) {
  return (
    <div>
      <CardEyebrow>{kicker}</CardEyebrow>
      <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">
        {title}
      </h2>
    </div>
  );
}
