"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (Phase 12) so the POS is installable as a
 * standalone desktop/tablet app and keeps a usable window even if the server
 * is briefly unreachable right after boot.
 *
 * Renders nothing. Registration is skipped in development so the SW never
 * caches while iterating, and skipped when the browser has no SW support.
 *
 * It also carries the iOS half of the app-wide zoom lock, because this is the
 * one client component mounted on every route — login and POS included.
 */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registration failures are non-fatal — the app works fully online
        // without the service worker. Swallow so we never surface an error.
      });
    };

    // Wait until the page is fully loaded so SW registration never competes
    // with the initial render/network for the first paint.
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  // Zoom lock, the iOS half. Safari ignores `user-scalable=no` in a browser tab
  // and honours it only in a standalone install, so `maximumScale` in layout.tsx
  // and `touch-action` in globals.css leave one hole: WebKit's own pinch
  // `gesture*` events, which are not touch events and are not governed by
  // touch-action. Refusing them is what actually stops the page scaling on an
  // iPhone. No-ops on every other engine, which never fires them.
  useEffect(() => {
    const block = (event: Event) => event.preventDefault();
    const types = ["gesturestart", "gesturechange", "gestureend"];
    for (const type of types) document.addEventListener(type, block, { passive: false });
    return () => {
      for (const type of types) document.removeEventListener(type, block);
    };
  }, []);

  return null;
}
