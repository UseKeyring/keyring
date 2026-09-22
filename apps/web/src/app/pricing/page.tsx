import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { LandingCta } from "../landing-cta";
import { SiteFooter } from "../site-footer";
import { SiteNav } from "../site-nav";
import { Button } from "@keyring/ui/components/button";
import { SolarIcon } from "@keyring/ui/components/solar-icon";
import { isWaitlistEnabled } from "@/lib/waitlist";

export const metadata: Metadata = {
  title: "Keyring — Pricing",
  description:
    "Start free, upgrade when your product grows. Every plan includes the full console.",
};

// Runtime toggle (WAITLIST) needs per-request rendering so the page can
// bounce to /waitlist while the beta is on.
export const dynamic = "force-dynamic";

/*
 * Pricing tiers are placeholders — adjust numbers, limits and feature gates
 * here. Layout follows the landing (full-bleed 1920 cap, two-tone headline,
 * rounded-2xl pillar cards, inverted middle card).
 */

const TIERS = [
  {
    name: "Self-hosted",
    price: "$0",
    period: "free forever",
    blurb: "Run Keyring on your own infra. Same console, your bill is zero.",
    cta: "Deploy yourself",
    href: "https://github.com/flaxodev/access-controller-hub",
    featured: false,
    features: [
      "Full console — actions, roles, grants",
      "Unlimited workspaces & subjects",
      "Unlimited checks",
      "Bring your own database",
      "Community support",
    ],
  },
  {
    name: "Pro",
    price: "$12",
    period: "per project / month",
    blurb: "Hosted Keyring for products with real users.",
    cta: "Start 14-day trial",
    href: "/auth",
    featured: true,
    features: [
      "Everything in Self-hosted, plus:",
      "100,000 checks / month — then $2 per extra 100k",
      "100,000 subjects",
      "Unlimited workspaces",
      "1-year activity log retention",
      "Join-request approvals",
      "Email support",
      "Daily backups with 7-day restore",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "annual billing",
    blurb: "For platforms with compliance checklists.",
    cta: "Contact sales",
    href: "mailto:hello@keyring.sh",
    featured: false,
    features: [
      "Everything in Pro",
      "SSO / SAML",
      "Audit log export",
      "Custom data retention",
      "Uptime SLA",
      "Dedicated onboarding",
    ],
  },
];

const FAQS = [
  {
    q: "What is a check?",
    a: "One call to GET /api/v1/check (or the SQL function) evaluating a subject against an action. Checks are counted per call against your plan's monthly quota.",
  },
  {
    q: "What is a subject?",
    a: "Your end-user, keyed by your own external ID. Subjects live outside the console graph and cost nothing on their own — only their checks meter.",
  },
  {
    q: "Can I really self-host for free?",
    a: "Yes. Clone the repo, bring your own Postgres, and the full console is yours — no license fees, no check quotas.",
  },
  {
    q: "Do team members cost extra?",
    a: "No. Console seats are free on every plan — invite your whole team to operate the workspace.",
  },
  {
    q: "What happens if I exceed Pro quotas?",
    a: "Nothing breaks. Extra checks bill at $4 per million; if you outgrow subjects or retention, we'll nudge you toward a plan that fits.",
  },
  {
    q: "Is there an annual discount?",
    a: "Yes. Annual billing comes with two months free on Pro.",
  },
];

export default function PricingPage() {
  // Private beta: no public pricing while the waitlist is on — direct URL
  // entry bounces to /waitlist (middleware enforces this too).
  if (isWaitlistEnabled()) redirect("/waitlist");
  const waitlist = isWaitlistEnabled();
  return (
    <main className="min-h-screen bg-canvas">
      <SiteNav waitlist={waitlist} />

      <div className="px-5 md:px-12">
        <div className="mx-auto w-full max-w-[1920px]">
          <section className="flex flex-col gap-12 py-16 md:py-24">
            <div className="max-w-3xl">
              <span className="type-mono text-ink-muted">Pricing</span>
              <h1 className="mt-6 text-[clamp(2.75rem,6vw,4.5rem)] leading-[1.02] font-normal tracking-[-0.025em] text-balance text-ink-navy">
                Pay for checks,
                <br />
                <span className="text-ink-muted">not seats.</span>
              </h1>
              <p className="type-body mt-5 max-w-xl text-ink-muted">
                Self-host free forever — or let us run it from $12 a project.
                Every plan includes the full console.
              </p>
            </div>

            <div className="grid items-stretch gap-4 lg:grid-cols-3">
              {TIERS.map((t) => (
                <div
                  key={t.name}
                  className={
                    t.featured
                      ? "flex flex-col rounded-2xl bg-ink p-8 text-canvas"
                      : "flex flex-col rounded-2xl bg-pillar p-8"
                  }
                >
                  <div className="flex items-center justify-between">
                    <h3
                      className={
                        t.featured
                          ? "type-body-lg text-canvas"
                          : "type-body-lg text-ink-navy"
                      }
                    >
                      {t.name}
                    </h3>
                    {t.featured && (
                      <span className="type-mono rounded-full border border-canvas/20 px-3 py-1 text-canvas">
                        Most popular
                      </span>
                    )}
                  </div>
                  <div className="mt-6 flex items-baseline gap-2">
                    <span
                      className={
                        t.featured
                          ? "text-5xl font-extralight tracking-tight text-canvas tabular-nums"
                          : "text-5xl font-extralight tracking-tight text-ink tabular-nums"
                      }
                    >
                      {t.price}
                    </span>
                    <span
                      className={
                        t.featured ? "type-body-sm text-canvas/60" : "type-body-sm text-ink-muted"
                      }
                    >
                      {t.period}
                    </span>
                  </div>
                  <p
                    className={
                      t.featured
                        ? "type-body-sm mt-2 text-canvas/60"
                        : "type-body-sm mt-2 text-ink-muted"
                    }
                  >
                    {t.blurb}
                  </p>
                  <div className="mt-6">
                    {t.featured ? (
                      <Button
                        asChild
                        className="w-full bg-canvas text-ink hover:opacity-85"
                      >
                        <a href={t.href}>{t.cta}</a>
                      </Button>
                    ) : (
                      <Button asChild variant="secondary" className="w-full">
                        <a href={t.href}>{t.cta}</a>
                      </Button>
                    )}
                  </div>
                  <ul className="mt-8 flex flex-col gap-3">
                    {t.features.map((f) => (
                      <li key={f} className="flex items-start gap-2.5">
                        <SolarIcon
                          name="check"
                          className={
                            t.featured
                              ? "mt-0.5 h-4 w-4 shrink-0 text-canvas"
                              : "mt-0.5 h-4 w-4 shrink-0 text-ink"
                          }
                        />
                        <span
                          className={
                            t.featured
                              ? "type-body-sm text-canvas/80"
                              : "type-body-sm text-ink-navy"
                          }
                        >
                          {f}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="type-mono text-ink-muted">
              All prices in USD. Cancel anytime — your graph stays exportable.
            </p>
          </section>

          <section className="border-t border-hairline py-16 md:py-24">
            <div className="grid gap-8 lg:grid-cols-2">
              <div className="type-display-md text-ink">FAQ</div>
              <div>
                <h2 className="text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.05] font-normal tracking-[-0.02em] text-balance text-ink">
                  Questions,
                  <br />
                  <span className="text-ink-muted">answered.</span>
                </h2>
              </div>
            </div>
            <div className="mt-12 grid gap-x-12 gap-y-10 md:mt-16 md:grid-cols-2">
              {FAQS.map((f) => (
                <div key={f.q}>
                  <h3 className="type-body-lg text-ink-navy">{f.q}</h3>
                  <p className="type-body-sm mt-2 max-w-lg text-ink-muted">{f.a}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="flex flex-col items-center gap-6 border-t border-hairline py-16 text-center md:py-24">
            <h2 className="text-[clamp(2rem,4.5vw,3.25rem)] leading-[1.05] font-normal tracking-[-0.02em] text-balance text-ink">
              Still deciding?
              <br />
              <span className="text-ink-muted">
                {waitlist ? "Join the waitlist for early access." : "The free tier is fully usable."}
              </span>
            </h2>
            {waitlist ? (
              <Button asChild size="lg">
                <Link href="/waitlist">Join the waitlist</Link>
              </Button>
            ) : (
              <LandingCta large />
            )}
          </section>
        </div>
      </div>

      <SiteFooter waitlist={waitlist} />
    </main>
  );
}
