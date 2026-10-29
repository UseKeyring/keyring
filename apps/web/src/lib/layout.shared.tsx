import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

/*
 * The landing Nav (logo, links, theme toggle, CTA) renders above the docs
 * layout, so the sidebar/mobile title is a terse mono crumb rather than a
 * second logo, and fumadocs' own theme switch is off (the Nav owns it).
 */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      url: "/docs",
      title: (
        <span className="kr-docs-title">
          <span className="kr-docs-title-mark">[~]</span>
          <span>docs</span>
        </span>
      ),
    },
    themeSwitch: { enabled: false },
  };
}
