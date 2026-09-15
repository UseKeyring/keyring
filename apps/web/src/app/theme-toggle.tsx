"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { SolarIcon } from "@keyring/ui/components/solar-icon";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // next-themes only knows the resolved theme after hydration, so render
  // theme-independent output until mounted. Otherwise SSR HTML (light
  // default) mismatches the client's first render (e.g. system dark).
  const isDark = mounted && resolvedTheme === "dark";

  return (
    <button
      type="button"
      aria-label={
        mounted ? (isDark ? "Switch to light mode" : "Switch to dark mode") : "Toggle color mode"
      }
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink-navy transition-colors hover:bg-pillar"
    >
      {isDark ? (
        <SolarIcon name="sun" className="h-4 w-4" />
      ) : (
        <SolarIcon name="moon" className="h-4 w-4" />
      )}
    </button>
  );
}
