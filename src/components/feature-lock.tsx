"use client";

/**
 * The read-only preview a lockable feature renders for a business that is not
 * entitled to it (see `LOCKABLE_FEATURES` in src/lib/features.ts for which
 * features these are and why only they get this treatment).
 *
 * The page renders its real screen — that is the point, "see what is inside" —
 * with two things layered on:
 *
 *  - `inert` on the wrapper, so nothing inside can be clicked, typed into,
 *    submitted or even focused by keyboard. A `disabled` prop threaded through
 *    every control in both subtrees would have been a much larger change and
 *    would have missed one; one attribute cannot.
 *  - `useFeatureLocked()`, which the components that fetch on mount consult so
 *    they skip the request rather than firing it into the API's own
 *    `feature_disabled` refusal and painting the preview with error toasts.
 *
 * Neither is a security boundary and neither is asked to be: the API guard in
 * `withTenantScope` refuses every gated route for this business regardless of
 * what the browser does.
 */
import { createContext, useContext, type ReactNode } from "react";
import { LockIcon } from "lucide-react";

const FeatureLockContext = createContext(false);

/** True when this component is inside a locked preview and should not talk to the API. */
export function useFeatureLocked(): boolean {
  return useContext(FeatureLockContext);
}

export function FeatureLockNotice({ title }: { title: string }) {
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
    >
      <LockIcon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 text-sm leading-6">
        <p className="font-semibold">«{title}» برای کسب‌وکار شما فعال نیست.</p>
        <p className="mt-1">
          می‌توانید این بخش را ببینید و با امکانات آن آشنا شوید، اما تا زمانی که فعال نشود امکان انجام
          هیچ عملی در آن وجود ندارد. برای فعال‌سازی با پشتیبانی تماس بگیرید.
        </p>
      </div>
    </div>
  );
}

/**
 * Renders `children` untouched when the feature is on, and as an inert preview
 * behind `FeatureLockNotice` when it is off.
 */
export function FeatureLock({
  locked,
  title,
  children,
}: {
  locked: boolean;
  /** The feature's name, as the nav calls it — this is what the notice is about. */
  title: string;
  children: ReactNode;
}) {
  if (!locked) return <>{children}</>;

  return (
    <FeatureLockContext.Provider value={true}>
      <FeatureLockNotice title={title} />
      <div inert className="select-none opacity-60 grayscale-[0.35]">
        {children}
      </div>
    </FeatureLockContext.Provider>
  );
}
