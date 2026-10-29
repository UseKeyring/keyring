import { Inter_Tight, JetBrains_Mono } from "next/font/google";

/*
 * Console copy of the public site's ASCII type pair (same families and
 * variable names as `asciiFontVars` in ../ascii-shell): Inter Tight light
 * for page titles, JetBrains Mono for everything else. Kept local so the
 * console doesn't pull the marketing shell (nav, footer, field) into its
 * bundle.
 */
const display = Inter_Tight({
  subsets: ["latin"],
  weight: ["300", "400"],
  variable: "--a-font-display",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--a-font-mono",
});

export const consoleFontVars = `${display.variable} ${mono.variable}`;
