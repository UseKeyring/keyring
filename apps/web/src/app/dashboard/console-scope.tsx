"use client";

import { useLayoutEffect, type ReactNode } from "react";
import { consoleFontVars } from "./console-fonts";
import "./console.css";

/*
 * ASCII console scope. Tokens in console.css hang off `html.ascii-console`
 * (and `html:has(.ascii-console-root)` for the first, pre-hydration paint),
 * so Radix portals — dialogs, dropdowns, selects, sheets, tooltips — and the
 * root Sonner toaster, which all render straight under <body>, inherit the
 * console look too. The class (plus the font variables) is removed again
 * when the console unmounts, leaving the public site untouched.
 */
export function ConsoleScope({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const classes = ["ascii-console", ...consoleFontVars.split(" ")];
    const html = document.documentElement;
    html.classList.add(...classes);
    return () => html.classList.remove(...classes);
  }, []);

  return <div className={`ascii-console-root ${consoleFontVars}`}>{children}</div>;
}
