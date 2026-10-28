"use client";

import { useEffect } from "react";

/*
 * Fumadocs portals (search dialog, popovers) render straight into <body>,
 * outside the docs wrapper. Put the ASCII scope on <body> while docs are
 * mounted so those overlays pick up the same tokens and fonts.
 */
export function DocsPortalScope({ className }: { className: string }) {
  useEffect(() => {
    const classes = className.split(/\s+/).filter(Boolean);
    document.body.classList.add(...classes);
    return () => document.body.classList.remove(...classes);
  }, [className]);
  return null;
}
