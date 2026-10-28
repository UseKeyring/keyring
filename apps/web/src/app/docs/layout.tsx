import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";
import { GITHUB_URL } from "@/lib/site";
import { Nav, asciiFontVars } from "../ascii-shell";
import { DocsPortalScope } from "./portal-scope";
import "./docs.css";

/*
 * Docs in the ASCII system: the landing Nav sits on top as fumadocs'
 * "banner" (docs.css sets --fd-banner-height to its 64px), and the whole
 * reader is scoped under `.ascii .ascii-docs` so ascii.css tokens + fonts
 * apply and docs.css can map fumadocs' --color-fd-* onto them.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`ascii ascii-docs ${asciiFontVars}`}>
      <DocsPortalScope className={`ascii ascii-docs-portal ${asciiFontVars}`} />
      <Nav />
      <DocsLayout
        tree={source.pageTree}
        {...baseOptions()}
        sidebar={{
          footer: (
            <div className="kr-docs-sidefoot">
              <span>keyring · mit</span>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                github ↗
              </a>
            </div>
          ),
        }}
      >
        {children}
      </DocsLayout>
    </div>
  );
}
