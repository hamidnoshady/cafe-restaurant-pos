"use client";

/**
 * A settings row whose subject already has a full screen of its own.
 *
 * Accounting, the CRM and the website manager each had their own byte-identical
 * copy of this component (`settings-shortcuts.tsx`, three files differing only
 * in the exported name). One copy meant one place to fix the arrow below, and
 * three places to forget it.
 *
 * The rule it encodes: when a setting already owns a screen, name the setting
 * here and open the screen that owns it. Duplicating the editor would fork two
 * editors over one table.
 *
 * The arrow points **left**, with no `rtl:` flip. The app is `dir="rtl"`
 * throughout (`src/app/layout.tsx`), so in Persian the inline *end* — where
 * "forward, open this" points — is the left. That is the same direction
 * `SectionNav`'s drill-down already uses (`ChevronLeftIcon` to go in,
 * `ChevronRightIcon` to come back). The previous `rtl:rotate-180` turned this
 * arrow around permanently, so every "open this page" button pointed backwards.
 */

import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";

export function AppSettingsShortcut({
  href,
  label,
  description,
}: {
  href: string;
  label: string;
  description: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 text-sm leading-6 text-muted-foreground">{description}</p>
      {/*
        Full width on a phone so the tap target spans the row rather than
        sitting in a 40px box at the edge; its natural width from `sm` up.
      */}
      <Link
        href={href}
        className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg border border-input px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 sm:w-auto dark:focus-visible:ring-amber-400/45"
      >
        {label}
        <ArrowLeftIcon aria-hidden="true" className="size-4 shrink-0" />
      </Link>
    </div>
  );
}
