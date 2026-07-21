"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * App-wide theme provider. The choice is stored per device in localStorage
 * (POS stations are fixed, so no per-user persistence in the DB) and defaults
 * to the OS `prefers-color-scheme` setting.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
