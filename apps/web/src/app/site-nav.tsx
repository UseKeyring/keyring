"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@keyring/ui/components/button";
import { KeyringWordmark } from "@keyring/ui/components/keyring-logo";
import { SolarIcon } from "@keyring/ui/components/solar-icon";
import { ThemeToggle } from "./theme-toggle";
import { LandingCta } from "./landing-cta";

const LINKS = [
  { title: "Model", href: "/#model" },
  { title: "Checks", href: "/#checks" },
  { title: "Roles", href: "/#roles" },
  { title: "Pricing", href: "/pricing" },
];

export function SiteWordmark({ size = "text-base" }: { size?: string }) {
  return <KeyringWordmark size={size} />;
}

export function SiteNav({ waitlist = false }: { waitlist?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="sticky top-0 z-30 w-full bg-canvas">
      <nav className="mx-auto flex h-16 w-full max-w-[1920px] items-center justify-between px-5 md:px-12">
        <div className="flex items-center gap-10">
          <SiteWordmark />
          {!waitlist && (
            <ul className="hidden items-center gap-1 md:flex">
              {LINKS.map((l) => (
                <li key={l.title}>
                  <a
                    href={l.href}
                    className="type-body-sm rounded-full px-3 py-2 text-ink-navy transition-colors hover:text-ink"
                  >
                    {l.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <ThemeToggle />
          {waitlist ? (
            <Button asChild>
              <a href="/waitlist">Join the waitlist</a>
            </Button>
          ) : (
            <>
              <Button variant="ghost" className="rounded-full" asChild>
                <Link href="/auth">Sign in</Link>
              </Button>
              <LandingCta />
            </>
          )}
        </div>
        <div className="flex items-center gap-1 md:hidden">
          <ThemeToggle />
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-navy hover:bg-pillar"
          >
            {open ? (
              <SolarIcon name="close" className="h-5 w-5" />
            ) : (
              <SolarIcon name="menu" className="h-5 w-5" />
            )}
          </button>
        </div>
      </nav>

      {open && (
        <div className="border-t border-hairline px-5 py-4 md:hidden">
          <div className="flex flex-col gap-1">
            {!waitlist &&
              LINKS.map((l) => (
                <a
                  key={l.title}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="type-h2 py-2 tracking-tight text-ink-navy"
                  style={{ fontSize: "24px", lineHeight: "32px" }}
                >
                  {l.title}
                </a>
              ))}
            {waitlist ? (
              <div className="pt-3" onClick={() => setOpen(false)}>
                <Button asChild size="lg" className="w-full">
                  <a href="/waitlist">Join the waitlist</a>
                </Button>
              </div>
            ) : (
              <>
                <Link
                  href="/auth"
                  onClick={() => setOpen(false)}
                  className="type-h2 py-2 tracking-tight text-ink-navy"
                  style={{ fontSize: "24px", lineHeight: "32px" }}
                >
                  Sign in
                </Link>
                <div className="pt-3" onClick={() => setOpen(false)}>
                  <LandingCta large />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
