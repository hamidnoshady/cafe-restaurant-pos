/**
 * The chrome every dashboard page is built from.
 *
 * The dashboard's look was set by the newest screens (Phase 25/27/29 —
 * `inventory`, `jewelry`, `watch`, `accessories`, `cosmetics`): a warm stone
 * canvas, one 1600px column, an underlined page header, amber-accented tab
 * pills tall enough for a touch screen, and `rounded-2xl` section cards. Every
 * page written before that language settled had its own header spacing, its own
 * tab style and its own card border, so moving between two screens of the same
 * product looked like moving between two products.
 *
 * These components are that language, in one place. A page composes them
 * instead of re-deriving the classes — so a change to the shared look is one
 * edit, and a new page cannot drift by accident. See docs/ui-conventions.md.
 *
 * Deliberately not a client component: a page shell is markup, and every server
 * page can import it directly. Nothing here takes a callback except `TabBar`,
 * which is only ever rendered from a client manager.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one-column page canvas. Wraps every dashboard page so a wide monitor
 * doesn't stretch a table to 3000px while a laptop shows the same page snug.
 */
export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-[1600px]", className)}>{children}</div>;
}

/**
 * A page's title, one line of what the page is for, and optional actions on the
 * far side. The rule underneath separates the header from the page's content
 * without needing a card around it.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Page-level controls (a date range, an export button) — rendered opposite the title. */
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-stone-200/80 pb-5 sm:mb-6 sm:pb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-stone-950 sm:text-[1.7rem]">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * The card skin — border, radius and the one-pixel warm shadow. `SectionCard` is
 * built from it; a surface whose *layout* is bespoke (a chat panel that fills a
 * fixed height, a canvas that scrolls) composes this instead of restating the
 * classes, so there is still exactly one definition of what a card looks like.
 */
export const cardClass = "rounded-2xl border border-stone-200/80 bg-card shadow-[0_1px_2px_rgb(41_37_36/0.035)]";

/**
 * A titled surface. Two shapes, one component: pass `flush` for a card whose
 * body is an edge-to-edge list or table (the divider lines reach the card's
 * edges), otherwise the body gets the standard padding.
 *
 * The `<section>` takes its accessible name from a string `title`, which makes
 * it a landmark a screen reader can jump to without the caller inventing an id.
 */
export function SectionCard({
  title,
  description,
  actions,
  footer,
  children,
  flush,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Controls belonging to this card — rendered opposite its title. */
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  /** The body is a list/table that should reach the card's edges. */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      aria-label={typeof title === "string" ? title : undefined}
      className={cn("min-w-0 overflow-hidden", cardClass, className)}
    >
      {title ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200/80 px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <h2 className="font-semibold text-stone-950">{title}</h2>
            {description ? (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children ? (
        <div className={cn(flush ? "min-w-0" : "min-w-0 p-4 sm:p-5", bodyClassName)}>{children}</div>
      ) : null}
      {footer ? (
        <div className="border-t border-stone-200/80 bg-stone-50/60 px-4 py-3 text-xs leading-5 text-stone-600 sm:px-5">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

export interface Tab<K extends string> {
  key: K;
  label: string;
}

/**
 * The dashboard's tab strip: a card of pills, two per row on a phone and a
 * single wrapping row from `sm` up. 52px tall because these are pressed on
 * tablets at a counter, and `aria-pressed` rather than `role="tab"` because the
 * panel below is a plain region, not a tabpanel widget.
 */
export function TabBar<K extends string>({
  idPrefix,
  label,
  tabs,
  active,
  onChange,
  className,
}: {
  /** Prefixes the button and panel ids, so two strips can coexist on a page. */
  idPrefix: string;
  label: string;
  tabs: readonly Tab<K>[];
  active: K;
  onChange: (key: K) => void;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "rounded-2xl border border-stone-200/80 bg-card p-2 shadow-[0_1px_2px_rgb(41_37_36/0.03)]",
        className,
      )}
    >
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {tabs.map((tab) => {
          const isActive = active === tab.key;
          return (
            <button
              key={tab.key}
              id={`${idPrefix}-tab-${tab.key}`}
              type="button"
              aria-pressed={isActive}
              aria-controls={`${idPrefix}-tabpanel`}
              onClick={() => onChange(tab.key)}
              className={cn(
                "min-h-[52px] rounded-xl border px-3 text-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-amber-400/40 sm:px-4",
                isActive
                  ? "border-amber-200 bg-amber-100 text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)]"
                  : "border-transparent bg-transparent text-stone-600 hover:border-stone-200 hover:bg-stone-50 hover:text-stone-950",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * The region a `TabBar` controls. Separate from `TabBar` so a manager can put
 * an error box or a warning banner between the strip and the panel.
 */
export function TabPanel<K extends string>({
  idPrefix,
  active,
  children,
}: {
  idPrefix: string;
  active: K;
  children: ReactNode;
}) {
  return (
    <div
      id={`${idPrefix}-tabpanel`}
      role="region"
      aria-labelledby={`${idPrefix}-tab-${active}`}
      className="min-w-0"
    >
      {children}
    </div>
  );
}

/** What a page shows where a list would be, before anything has been created. */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * A state pill, in the shape and the four tones the Phase 25/27 screens
 * established — amber for "in progress", green for "done", stone for "no longer
 * relevant", red for "needs attention" — so a status reads the same everywhere.
 */
export function StatusBadge({
  tone = "neutral",
  children,
}: {
  tone?: "active" | "positive" | "neutral" | "danger";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "active" && "bg-amber-100 text-amber-950",
        tone === "positive" && "bg-emerald-100 text-emerald-900",
        tone === "neutral" && "bg-stone-100 text-stone-600",
        tone === "danger" && "bg-destructive/10 text-destructive",
      )}
    >
      {children}
    </span>
  );
}
