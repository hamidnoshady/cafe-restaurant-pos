"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

/**
 * Kitchens are hot, steamy environments where staff prefer dark screens, so
 * the KDS defaults to dark mode regardless of the OS setting. It only kicks
 * in while the device has no explicit choice saved (theme === "system");
 * once staff use the sun/moon toggle, that per-device choice always wins.
 */
export function KdsDarkDefault() {
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    if (theme === "system") setTheme("dark");
    // Run once on mount — reacting to later theme changes would fight the manual toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
