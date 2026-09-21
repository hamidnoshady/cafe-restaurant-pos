"use client";

/**
 * Post-download watch for the Windows Print Connector install.
 *
 * Once the operator downloads the generated .cmd, the installer typically
 * finishes within seconds — but the page used to sit silent until they came
 * back and pressed «بررسی دوباره». This hook polls the loopback connector
 * for a bounded window after the download starts and fires `onReady` the
 * moment a healthy connector answers, so the page flips to "ready" on its
 * own. Kept out of the .tsx so the effect plumbing stays in one place.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { connectorHealth } from "@/lib/printing/client";

/** How long the watch keeps polling after the download starts. */
const INSTALL_WATCH_MS = 3 * 60_000;
const INSTALL_POLL_MS = 3_000;

export function useConnectorInstallWatch(onReady: () => void) {
  const [installing, setInstalling] = useState(false);
  /** Ref mirror so cleanup and timers always read the latest flag. */
  const installingRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchUntil = useRef(0);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const stop = useCallback(() => {
    installingRef.current = false;
    setInstalling(false);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const begin = useCallback(() => {
    watchUntil.current = Date.now() + INSTALL_WATCH_MS;
    installingRef.current = true;
    setInstalling(true);
  }, []);

  useEffect(() => {
    if (!installing) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || !installingRef.current) return;
      const result = await connectorHealth({ force: true });
      if (cancelled || !installingRef.current) return;
      if (result.ok) {
        stop();
        onReadyRef.current();
        return;
      }
      if (Date.now() < watchUntil.current) {
        timer.current = setTimeout(tick, INSTALL_POLL_MS);
      } else {
        stop();
      }
    };
    timer.current = setTimeout(tick, INSTALL_POLL_MS);
    return () => {
      cancelled = true;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [installing, stop]);

  // Never let the watch outlive the screen it was started on.
  useEffect(() => () => stop(), [stop]);

  return { installing, begin, stop };
}
