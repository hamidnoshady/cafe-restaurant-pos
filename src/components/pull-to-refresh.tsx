"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
 */

/** `router.refresh()` reports no completion, so the spinner is time-boxed. */
const SPINNER_MS = 900;

export function PullToRefresh({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
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
      router.refresh();
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
  }, [router]);

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
