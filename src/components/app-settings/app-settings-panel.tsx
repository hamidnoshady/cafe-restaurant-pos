"use client";

/**
 * The shape every *app's own* settings screen takes.
 *
 * The rule this component exists to make structural: **`/settings` is the
 * platform's settings area and an app's settings are the app's own.** Before
 * this, «تنظیمات» inside an app either rendered the platform `SettingsPage`
 * outright or redirected to `/settings`, so an owner who opened Growth's
 * settings landed on printers and tax rates — the platform's business
 * configuration — with no way to tell whose page they were on.
 *
 * So an app settings page is a different route with a different component, a
 * different title and a different description (see `APP_SETTINGS_HREFS` in
 * `src/lib/app-routes.ts`), and this panel gives all four of them the same
 * anatomy:
 *
 *  - `groups`, the app's own settings, each either implemented (a `body`) or
 *    an honest, named placeholder — never a 404 and never the platform page;
 *  - `platformLinks`, the settings that genuinely belong to the platform
 *    (billing, subscription, team, security). An app may link to them, and the
 *    link must *say* that it leaves the app for platform settings, which is
 *    what `PlatformSettingsLink` spells out.
 */

import Link from "next/link";
import { ArrowUpRightIcon, ClockIcon, type LucideIcon } from "lucide-react";
import { SectionCard, cardClass } from "@/app/dashboard/page-chrome";

export interface AppSettingsGroup {
  key: string;
  label: string;
  description: string;
  icon?: LucideIcon;
  /** The implemented control surface. Omit for a not-built-yet section. */
  body?: React.ReactNode;
  /**
   * Shown instead of `body` while the section is not built. A real, titled
   * empty state — the requirement is explicitly that an unimplemented app
   * setting renders a "coming soon" page inside the app shell rather than a
   * 404 or somebody else's settings.
   */
  comingSoon?: string;
}

export interface PlatformSettingsLink {
  label: string;
  description: string;
  href: string;
}

export function AppSettingsPanel({
  groups,
  platformLinks = [],
  platformNote,
}: {
  groups: AppSettingsGroup[];
  platformLinks?: PlatformSettingsLink[];
  /** One line explaining why the links below leave the app. */
  platformNote?: string;
}) {
  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const Icon = group.icon;
        return (
          <SectionCard
            key={group.key}
            title={
              Icon ? (
                <span className="flex items-center gap-2">
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-amber-700 dark:text-amber-300" />
                  {group.label}
                </span>
              ) : (
                group.label
              )
            }
            description={group.description}
          >
            {group.body ?? (
              <div className="flex items-start gap-3 rounded-xl border border-dashed border-border px-4 py-5">
                <ClockIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <p className="text-sm leading-6 text-muted-foreground">
                  {group.comingSoon ?? "این بخش هنوز آماده نشده و به‌زودی در همین صفحه اضافه می‌شود."}
                </p>
              </div>
            )}
          </SectionCard>
        );
      })}

      {platformLinks.length > 0 ? (
        <SectionCard
          title="تنظیمات پلتفرم"
          description={
            platformNote ??
            "این موارد متعلق به تنظیمات پلتفرم است، نه این برنامه؛ با باز کردن آن‌ها از این برنامه خارج می‌شوید."
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {platformLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`${cardClass} flex gap-3 p-4 transition-colors hover:border-amber-300/70 hover:bg-amber-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:hover:border-amber-500/40 dark:hover:bg-amber-500/10 dark:focus-visible:ring-amber-400/45`}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-1 font-semibold text-foreground">
                    {link.label}
                    <ArrowUpRightIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground rtl:rotate-90"
                    />
                  </span>
                  <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                    {link.description}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
