"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * App-wide theme provider. The choice is stored per device in localStorage
 * (POS stations are fixed, so no per-user persistence in the DB) and defaults
 * to the OS `prefers-color-scheme` setting.
 */
export function ThemeProvider({ children, nonce }: { children: React.ReactNode, nonce?: string }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      nonce={nonce}
    >
      {children}
    </NextThemesProvider>
  );
}
