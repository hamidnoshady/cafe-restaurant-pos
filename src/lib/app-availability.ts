/**
 * Turning an *app* off, with a reason — the vocabulary and the rules.
 *
 * The console has had one switch per capability since Phase 15
 * (`feature_flags` / `business_features`, read by `features.ts`): a boolean,
 * meaning "this business is entitled to inventory" or "it is not". That is the
 * right model for an entitlement and the wrong one for every other reason an
 * app is not usable right now — a release that has not landed, an hour of
 * maintenance, a beta the operator wants labelled. Those are *states of the
 * app*, they are temporary, and — unlike an entitlement — the business should
 * be told about them rather than have the app quietly vanish.
 *
 * So this is a second, orthogonal axis over the app registry (`apps.ts`):
 *
 *   entitlement (features.ts)  — "did this business buy it?"      → hidden
 *   availability (this file)   — "is it working / released?"      → shown, badged, locked
 *   module (industry-profile)  — "does this trade have it at all?" → does not exist
 *
 * Three questions, three files, one answer each — the split `apps.ts`,
 * `app-shells.ts` and `settings-tabs.ts` already keep. An app that is blocked
 * here stays in the nav with its badge and opens an explanation screen
 * (`app-availability-gate.tsx`); its API routes refuse with `app_unavailable`
 * (auth.ts), so the lock is not decoration.
 *
 * Framework-free on purpose (no `db`, no `next`): the sidebar, the platform
 * console and the edge-safe guards all import it directly. The DB half —
 * reading the platform row and the per-business override — is
 * `app-availability-service.ts`.
 */
import { appForModule, isAppKey, type AppKey } from "./apps";
import { moduleForApiPath, moduleForPagePath } from "./industry-profile";

export const APP_AVAILABILITY_STATES = [
  "available",
  "beta",
  "coming_soon",
  "maintenance",
  "disabled",
] as const;
export type AppAvailabilityState = (typeof APP_AVAILABILITY_STATES)[number];

/** The default for an app with no row anywhere: on, unbadged, exactly as before this feature existed. */
export const DEFAULT_APP_AVAILABILITY_STATE: AppAvailabilityState = "available";

export interface AppAvailabilityStateMeta {
  state: AppAvailabilityState;
  /** The word the console and the badge use. */
  label: string;
  /** One line for the operator picking the state in the console. */
  hint: string;
  /**
   * Whether the app is usable. `false` means the pages render the explanation
   * screen and the API refuses — `beta` deliberately does not, since a beta is
   * shipped software that merely wants labelling.
   */
  usable: boolean;
  /** Whether the badge is shown at all (`available` is the silent, ordinary state). */
  badged: boolean;
  /** What the business is told when the operator left no note of their own. */
  defaultNotice: string;
}

export const APP_AVAILABILITY_META: Record<AppAvailabilityState, AppAvailabilityStateMeta> = {
  available: {
    state: "available",
    label: "فعال",
    hint: "برنامه به‌طور عادی در دسترس است.",
    usable: true,
    badged: false,
    defaultNotice: "",
  },
  beta: {
    state: "beta",
    label: "نسخهٔ آزمایشی",
    hint: "برنامه در دسترس است، اما با برچسب «آزمایشی» به کاربر نشان داده می‌شود.",
    usable: true,
    badged: true,
    defaultNotice:
      "این برنامه در نسخهٔ آزمایشی است. می‌توانید از آن استفاده کنید، اما ممکن است بخش‌هایی هنوز کامل نباشد.",
  },
  coming_soon: {
    state: "coming_soon",
    label: "به‌زودی",
    hint: "برنامه هنوز منتشر نشده است؛ کاربر آن را می‌بیند اما نمی‌تواند وارد شود.",
    usable: false,
    badged: true,
    defaultNotice: "این برنامه هنوز منتشر نشده است و به‌زودی در دسترس قرار می‌گیرد.",
  },
  maintenance: {
    state: "maintenance",
    label: "در حال تعمیر",
    hint: "برنامه موقتاً برای تعمیر و نگهداری بسته است.",
    usable: false,
    badged: true,
    defaultNotice:
      "این برنامه موقتاً برای تعمیر و نگهداری در دسترس نیست. لطفاً کمی بعد دوباره تلاش کنید.",
  },
  disabled: {
    state: "disabled",
    label: "غیرفعال",
    hint: "برنامه در این نصب خاموش است.",
    usable: false,
    badged: true,
    defaultNotice: "این برنامه در حال حاضر غیرفعال است. برای فعال‌سازی با پشتیبانی تماس بگیرید.",
  },
};

/** Type guard for a state coming off the wire or out of the database. */
export function isAppAvailabilityState(value: unknown): value is AppAvailabilityState {
  return (
    typeof value === "string" && (APP_AVAILABILITY_STATES as readonly string[]).includes(value)
  );
}

/** One app's state, as stored on the platform row or on a business's override. */
export interface AppAvailabilityRecord {
  state: AppAvailabilityState;
  /** The operator's own sentence, shown instead of `defaultNotice`. */
  note: string | null;
  /** ISO/Gregorian `YYYY-MM-DD` — storage and the wire are Gregorian; screens render Shamsi. */
  availableFrom: string | null;
}

/** The state actually in force for one app, and where it came from. */
export interface ResolvedAppAvailability extends AppAvailabilityRecord {
  app: AppKey;
  /** `"business"` when a per-business override decided it, `"platform"` otherwise. */
  source: "platform" | "business";
  /** Whether the app may be used — the one question every guard asks. */
  usable: boolean;
  /** Whether a badge should be drawn next to the app's name. */
  badged: boolean;
  /** The state's Persian name, for that badge. */
  label: string;
  /** `note` if the operator wrote one, else the state's stock sentence. Empty for `available`. */
  notice: string;
}

export const DEFAULT_APP_AVAILABILITY: AppAvailabilityRecord = {
  state: DEFAULT_APP_AVAILABILITY_STATE,
  note: null,
  availableFrom: null,
};

/**
 * Resolve one app: the per-business override if it has one, else the
 * platform-wide row, else the default.
 *
 * An override replaces the platform row wholesale rather than merging field by
 * field — an operator who pins one business to «در حال تعمیر» with their own
 * note means exactly that, and inheriting a half of the global row would make
 * the console's readout impossible to reason about.
 */
export function resolveAppAvailability(
  app: AppKey,
  platform: AppAvailabilityRecord | null | undefined,
  business?: AppAvailabilityRecord | null,
): ResolvedAppAvailability {
  const source: "platform" | "business" = business ? "business" : "platform";
  const record = business ?? platform ?? DEFAULT_APP_AVAILABILITY;
  const meta = APP_AVAILABILITY_META[record.state] ?? APP_AVAILABILITY_META.available;
  const note = record.note?.trim() ? record.note.trim() : null;
  return {
    app,
    source,
    state: meta.state,
    note,
    availableFrom: record.availableFrom ?? null,
    usable: meta.usable,
    badged: meta.badged,
    label: meta.label,
    notice: note ?? meta.defaultNotice,
  };
}

/** The whole registry resolved at once, keyed by app. */
export type AppAvailabilityMap = Record<AppKey, ResolvedAppAvailability>;

/** Convenience for the guards: is this app usable in an already-resolved map? */
export function isAppUsable(map: AppAvailabilityMap | undefined, app: AppKey | null): boolean {
  if (!app || !map) return true;
  return map[app]?.usable ?? true;
}

/**
 * Which app owns a dashboard path — the page half of the guard.
 *
 * Answered through the module maps rather than a third prefix table: a route
 * already declares its module (`industry-profile.ts`) and a module already
 * declares its app (`apps.ts`), so adding a page keeps needing exactly one
 * registration, not two. The chat home, projects and the assistant have no
 * owning app and so are never blocked — the explanation screen has to be
 * reachable from somewhere.
 */
export function appForPagePath(pathname: string): AppKey | null {
  const module = moduleForPagePath(pathname);
  return module ? appForModule(module) : null;
}

/** The API half of the same question, over `moduleForApiPath`. */
export function appForApiPath(pathname: string): AppKey | null {
  const module = moduleForApiPath(pathname);
  return module ? appForModule(module) : null;
}

/** Parse an app key off the wire (a console PATCH body, a query string). */
export function parseAppKey(value: unknown): AppKey | null {
  return typeof value === "string" && isAppKey(value) ? value : null;
}
