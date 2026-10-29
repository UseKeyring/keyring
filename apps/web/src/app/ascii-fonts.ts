import { Inter_Tight, JetBrains_Mono } from "next/font/google";

/*
 * The ASCII type pair, declared once and shared by the public site
 * (ascii-shell) and the console (ConsoleScope): Inter Tight light for
 * display, JetBrains Mono for everything else.
 */
const display = Inter_Tight({ subsets: ["latin"], weight: ["300", "400"], variable: "--a-font-display" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--a-font-mono" });

export const asciiFontVars = `${display.variable} ${mono.variable}`;
