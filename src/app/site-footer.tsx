import Link from "next/link";
import { SiteWordmark } from "./site-nav";
import { SolarIcon } from "@/components/ui/solar-icon";

const SECTIONS: { title: string; links: { title: string; href: string }[] }[] = [
  {
    title: "Product",
    links: [
      { title: "Model", href: "/#model" },
      { title: "Checks", href: "/#checks" },
      { title: "Roles", href: "/#roles" },
      { title: "Pricing", href: "/pricing" },
    ],
  },
  {
    title: "Console",
    links: [
      { title: "Open console", href: "/dashboard" },
      { title: "Account settings", href: "/dashboard/account" },
    ],
  },
  {
    title: "Resources",
    links: [
      { title: "Why Keyring", href: "/#model" },
      { title: "Sign in", href: "/auth" },
      { title: "Open console", href: "/dashboard" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="w-full border-t border-hairline">
      <div className="mx-auto grid w-full max-w-[1920px] gap-12 px-5 py-12 md:px-12 md:py-16 lg:grid-cols-2">
        <div className="flex flex-col items-start justify-between gap-12">
          <SiteWordmark size="text-lg" />
          <div className="flex flex-col gap-4">
            <Link href="/auth" className="w-fit border-b border-current pb-0.5">
              <span className="type-label inline-flex items-center gap-1 text-ink-navy">
                Create your workspace
                <SolarIcon name="arrowUpRight" className="h-4 w-4" />
              </span>
            </Link>
            <p className="type-body-sm text-ink-muted">
              &copy; Keyring {new Date().getFullYear()}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-12 sm:grid-cols-3">
          {SECTIONS.map((s) => (
            <div key={s.title} className="flex flex-col gap-4">
              <h3 className="type-body-sm text-ink-muted">{s.title}</h3>
              <div className="flex flex-col gap-2">
                {s.links.map((l) =>
                  l.href.startsWith("/#") ? (
                    <a
                      key={l.title}
                      href={l.href}
                      className="type-label w-fit text-ink-navy transition-colors hover:text-ink"
                    >
                      {l.title}
                    </a>
                  ) : (
                    <Link
                      key={l.title}
                      href={l.href as "/dashboard" | "/dashboard/account" | "/auth" | "/pricing"}
                      className="type-label w-fit text-ink-navy transition-colors hover:text-ink"
                    >
                      {l.title}
                    </Link>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </footer>
  );
}
