"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { PULL_THRESHOLD_PX, pullOffset, pullStartsHere } from "@/lib/pull-to-refresh";

/**
 * Pull-to-refresh for the *installed* app.
 *
 * A browser tab already has this gesture — it belongs to the browser chrome. An
 * installed PWA has no chrome to put it in, so on iOS (and on Android in
 * standalone mode) pulling the page down does nothing at all, which reads as a
 * frozen app. That is what this restores, and only there: in a tab the native
 * gesture is left alone rather than doubled up.
 *
 * It renders the scrolling `<main>` itself rather than reaching for one, because
 * the dashboard's scroller is that element and not the document — which is the
 * other half of why the native gesture never fired even where it exists. The
 * two decisions it makes (whose gesture this is, and how far to show the pull)
 * live in `src/lib/pull-to-refresh.ts`, where they are tested.
 *
 * A committed pull reloads the document. It used to call `router.refresh()`,
 * which re-runs server components and nothing else — and almost every screen in
 * this dashboard is a client component that loads its own data in an effect
 * (`/api/menu`, `/api/orders`, `/api/dashboard/overview`, …). So the pull
 * animated, the spinner spun, not one request was made and nothing on screen
 * changed: the gesture appeared to do nothing at all, which is exactly what it
 * did. A reload is also what the browser gesture this restores does, so an
 * installed app and a tab now behave the same way — including in what they cost
 * you, which is why the gesture starts only at the very top of a page and asks
 * for 144px of deliberate travel.
 */

/**
 * Safety net only: the reload normally replaces this document long before it
 * fires. It exists so a reload the browser refuses (or defers) cannot leave the
 * spinner turning for ever.
 */
const SPINNER_MS = 4000;

export function PullToRefresh({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const installed =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (!installed) return;

    let startY: number | null = null;

    const track = (value: number) => {
      pullRef.current = value;
      setPull(value);
    };

    const onStart = (event: TouchEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      startY =
        event.touches.length === 1 && !refreshingRef.current && pullStartsHere(target, root)
          ? event.touches[0].clientY
          : null;
    };

    const onMove = (event: TouchEvent) => {
      if (startY === null) return;
      const offset = pullOffset(event.touches[0].clientY - startY);
      if (offset === null) {
        startY = null;
        track(0);
        return;
      }
      // Own the pull so iOS rubber-bands the indicator, not the whole webview.
      if (event.cancelable) event.preventDefault();
      track(offset);
    };

    const onEnd = () => {
      if (startY === null) return;
      const commit = pullRef.current >= PULL_THRESHOLD_PX;
      startY = null;
      track(0);
      if (!commit) return;
      refreshingRef.current = true;
      setRefreshing(true);
      window.location.reload();
      window.setTimeout(() => {
        refreshingRef.current = false;
        setRefreshing(false);
      }, SPINNER_MS);
    };

    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onEnd);
    root.addEventListener("touchcancel", onEnd);
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onEnd);
      root.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  const armed = pull >= PULL_THRESHOLD_PX;

  return (
    <main ref={ref} className={className}>
      <div
        className="flex items-center justify-center overflow-hidden"
        style={{ height: refreshing ? 36 : pull }}
        role="status"
        aria-live="polite"
      >
        <Loader2Icon
          aria-hidden="true"
          className={`size-5 text-[#B97905] ${refreshing ? "animate-spin" : ""}`}
          style={
            refreshing
              ? undefined
              : { transform: `rotate(${(pull / PULL_THRESHOLD_PX) * 270}deg)` }
          }
        />
        <span className="sr-only">
          {refreshing ? "به‌روزرسانی صفحه" : armed ? "برای به‌روزرسانی رها کنید" : ""}
        </span>
      </div>
      {children}
    </main>
  );
}
