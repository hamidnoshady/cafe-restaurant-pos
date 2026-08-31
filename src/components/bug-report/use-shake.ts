"use client";

import { useEffect, useRef } from "react";
import { createShakeDetector } from "./shake";

/**
 * Detects a phone "shake" and fires `onShake`.
 *
 * Reads the raw `devicemotion` event (acceleration including gravity, so a
 * phone resting on a table still reads ~9.8 m/s² — the threshold is chosen
 * above that) and feeds each sample into the pure classifier in shake.ts.
 *
 * iOS gatekeepers this behind a permission (`DeviceMotionEvent.requestPermission`)
 * that may only be requested from a user gesture, so the hook exposes
 * `requestPermission()` for the report button to call on tap — from then on,
 * shaking works on iOS too.
 */

type PermissionState = "granted" | "denied" | "unavailable";

export function useShakeDetection(onShake: () => void) {
  const onShakeRef = useRef(onShake);
  onShakeRef.current = onShake;

  const requestPermission = async (): Promise<PermissionState> => {
    const DeviceMotion = DeviceMotionEvent as unknown as
      | (typeof DeviceMotionEvent & { requestPermission?: () => Promise<"granted" | "denied"> })
      | undefined;

    if (typeof DeviceMotion?.requestPermission === "function") {
      try {
        const result = await DeviceMotion.requestPermission();
        return result === "granted" ? "granted" : "denied";
      } catch {
        return "denied";
      }
    }
    // Android / desktop: no permission needed.
    return "granted";
  };

  useEffect(() => {
    const detector = createShakeDetector();

    const handleMotion = (event: DeviceMotionEvent) => {
      const acc = event.accelerationIncludingGravity ?? event.acceleration;
      if (!acc || acc.x == null || acc.y == null || acc.z == null) return;

      const magnitude = Math.sqrt(acc.x ** 2 + acc.y ** 2 + acc.z ** 2);
      if (detector.update(Date.now(), magnitude)) onShakeRef.current();
    };

    const onVisibilityChange = () => {
      if (document.hidden) detector.reset();
    };

    window.addEventListener("devicemotion", handleMotion, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("devicemotion", handleMotion);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return { requestPermission };
}
