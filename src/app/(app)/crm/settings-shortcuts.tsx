"use client";

/**
 * A CRM settings row whose subject already has a screen of its own.
 *
 * Same reasoning as Accounting's: naming the setting here and opening the page
 * that owns it beats forking a second editor over one table — and it keeps the
 * destination inside the CRM rather than out at platform settings.
 */

import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";

export function CrmSettingsShortcut({
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
      <Link
        href={href}
        className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg border border-input px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
      >
        {label}
        <ArrowLeftIcon aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
      </Link>
    </div>
  );
}
