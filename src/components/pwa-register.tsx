"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (Phase 12) so the POS is installable as a
 * standalone desktop/tablet app and keeps a usable window even if the server
 * is briefly unreachable right after boot.
 *
 * Renders nothing. Registration is skipped in development so the SW never
 * caches while iterating, and skipped when the browser has no SW support.
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

  return null;
}
