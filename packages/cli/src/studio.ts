import html from "./studio.html" with { type: "text" };
import tokens from "../../../apps/web/src/app/ascii-tokens.css" with { type: "text" };
import { KEYRING_MARK } from "./mark.js";

/**
 * Single-file local console, inlined at build time (bun text loader). The
 * website's ASCII tokens are spliced in so Studio can never drift from the
 * site's palette (apps/web/src/app/ascii-tokens.css is the one source).
 */
export const STUDIO_HTML: string = html.replace("/*__ASCII_TOKENS__*/", tokens).replaceAll("__KEYRING_MARK__", KEYRING_MARK);
