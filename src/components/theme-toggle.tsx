"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Sun/moon toggle between light and dark; persists per device via localStorage. */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // Render a stable placeholder until mounted — resolvedTheme is unknown on the server.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      aria-label="تغییر حالت روشن/تاریک"
      title="تغییر حالت روشن/تاریک"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {mounted && resolvedTheme === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
