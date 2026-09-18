"use client";

/**
 * What a business sees when an app is switched off in the super-admin console.
 *
 * The rule the console's states encode (src/lib/app-availability.ts) is
 * "announce, don't hide": «به‌زودی» and «در حال تعمیر» are temporary facts about
 * the product, and an app that silently disappears from the sidebar looks like
 * a product that never had the capability. So the nav entry stays, wearing its
 * badge, and the route lands here instead of on the app's own screen — the
 * state, the operator's note if they wrote one, and (in Shamsi, like every
 * other date in this product) when it is expected back.
 *
 * This is a UI affordance and nothing more, exactly like `FeatureLock`: the
 * enforcement is `withTenantScope`'s `app_unavailable` refusal in
 * src/lib/auth.ts, which answers 503 for every route the app owns regardless
 * of what the browser renders. A `beta` app is *usable* and so never reaches
 * this screen — it only picks up the badge.
 */
import { ClockIcon, WrenchIcon, CircleSlashIcon, type LucideIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  appForPagePath,
  type AppAvailabilityState,
  type ResolvedAppAvailability,
} from "@/lib/app-availability";
import { appForKey, type AppKey } from "@/lib/apps";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { cardClass, PageHeader, PageShell } from "./page-chrome";

const STATE_ICONS: Record<AppAvailabilityState, LucideIcon> = {
  available: ClockIcon,
  beta: ClockIcon,
  coming_soon: ClockIcon,
  maintenance: WrenchIcon,
  disabled: CircleSlashIcon,
};

/** The serialisable slice of the availability map the server hands the client. */
export type AppAvailabilityProps = Partial<Record<AppKey, ResolvedAppAvailability>>;

/**
 * The badge the sidebar and this screen share, so «به‌زودی» is spelled and
 * coloured the same in both places.
 *
 * Amber is the product's selection/warning hue (docs/design-system.md); a
 * withdrawn app is the only genuinely negative state and takes the muted
 * neutral rather than red — nothing is broken, the app is simply not here.
 */
export function AppStateBadge({
  state,
  label,
  className,
}: {
  state: AppAvailabilityState;
  label: string;
  className?: string;
}) {
  if (state === "available") return null;
  const tone =
    state === "disabled"
      ? "border-border bg-muted text-muted-foreground"
      : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone} ${className ?? ""}`}
    >
      {label}
    </span>
  );
}

function AvailabilityNotice({
  availability,
  backHref,
  backLabel,
  hideBack,
}: {
  availability: ResolvedAppAvailability;
  /** Where «back» escapes to — a surface that is never gated itself. */
  backHref: string;
  backLabel: string;
  /** True when this screen *is* the back target (no self-links). */
  hideBack: boolean;
}) {
  const Icon = STATE_ICONS[availability.state] ?? ClockIcon;
  const appLabel = appForKey(availability.app).label;
  return (
    <PageShell className="py-6">
      {/* The app's own name is the title — the state is the badge beside it —
          so the screen answers "which app, and why" in one line rather than
          leaving the member to work out what «در حال تعمیر» refers to. */}
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {appLabel}
            <AppStateBadge state={availability.state} label={availability.label} />
          </span>
        }
        description={`«${appLabel}» در حال حاضر در دسترس نیست.`}
      />
      <div className={`${cardClass} mt-4 p-6`}>
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border bg-muted text-muted-foreground"
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 space-y-3">
            <p className="text-sm leading-7 text-foreground">{availability.notice}</p>
            {availability.availableFrom ? (
              <p className="text-sm text-muted-foreground">
                زمان در دسترس بودن:{" "}
                <span className="font-medium text-foreground">
                  {toPersianDigits(
                    formatJalali(availability.availableFrom, { withMonthName: true }),
                  )}
                </span>
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              بقیهٔ بخش‌های برنامه مثل همیشه در دسترس هستند.
            </p>
            {hideBack ? null : (
              <Link
                href={backHref}
                className="inline-flex h-9 items-center rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                {backLabel}
              </Link>
            )}
          </div>
        </div>
      </div>
    </PageShell>
  );
}

/**
 * Renders `children` when the app that owns the current route is usable, and
 * the explanation screen when it is not.
 *
 * Which app owns the route is answered from the path (`appForPagePath`) rather
 * than threaded through every page, so a page added later is covered by the
 * module registration it already has to make. Routes with no owning app — the
 * chat home, projects, the assistant, the connections hub — are never gated,
 * which is also what keeps this screen's "back" link reachable.
 *
 * One route needs its shell to answer: `/dashboard` is the chat home (never
 * gated) in the workspace shell, but the operational overview
 * `/overview` renders in the classic shell. Leaving it ungated in
 * both would leave a sales «به‌زودی» bypassable from the home page, so in the
 * classic shell it is gated as part of Accounting.
 */
export function AppAvailabilityGate({
  availability,
  workspaceEnabled = true,
  children,
}: {
  availability: AppAvailabilityProps;
  /** False in the classic shell, where `/dashboard` renders the operational overview. */
  workspaceEnabled?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const app: AppKey | null =
    !workspaceEnabled && pathname === "/dashboard" ? "accounting" : appForPagePath(pathname);
  const state = app ? availability[app] : undefined;
  if (!state || state.usable) return <>{children}</>;
  // The escape hatch must itself be reachable: the chat home (never gated) in
  // the workspace shell, the overview otherwise. In the classic shell
  // that overview is Accounting-gated, so while Accounting is down the link
  // would only land on this same screen — it is hidden then, and on either
  // home, where the sidebar is the way out.
  const backHref = workspaceEnabled ? "/dashboard" : "/overview";
  const backUsable = workspaceEnabled || (availability.accounting?.usable ?? true);
  return (
    <AvailabilityNotice
      availability={state}
      backHref={backHref}
      backLabel={workspaceEnabled ? "بازگشت به میز کار" : "بازگشت به داشبورد"}
      hideBack={pathname === backHref || !backUsable}
    />
  );
}
