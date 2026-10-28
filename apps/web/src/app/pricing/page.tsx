import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { isWaitlistEnabled } from "@/lib/waitlist";
import { AsciiPage, Row, SectionHead, SectionLabel } from "../ascii-shell";
import { CopyCommand } from "../copy-command";

export const metadata: Metadata = {
  title: "Keyring — Pricing",
  description:
    "Self-host Keyring free forever. Hosted plans are coming soon.",
};

// Runtime toggle (WAITLIST) needs per-request rendering so the page can
// bounce to /waitlist while the beta is on.
export const dynamic = "force-dynamic";

/*
 * Pricing tiers are placeholders — adjust numbers, limits and feature gates
 * here. Layout follows the landing's ASCII system (railed rows, shared-border
 * cells, accent rule on the featured tier).
 */

const TIERS = [
  {
    name: "Self-hosted",
    price: "$0",
    period: "free forever",
    blurb: "Run Keyring on your own infra. Same console, your bill is zero.",
    cta: "Deploy yourself",
    href: "https://github.com/UseKeyring/keyring",
    featured: true,
    soon: false,
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
    cta: "Subscribe to Pro",
    href: "/auth",
    featured: false,
    soon: true,
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
    soon: true,
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
  return (
    <AsciiPage>
      <Row>
        <div className="pad" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <SectionLabel n="$">pricing</SectionLabel>
          <h1 className="display" style={{ fontSize: "clamp(2.5rem, 5vw, 4.2rem)", margin: 0, maxWidth: 900 }}>
            Free to run. <span className="muted">Hosted is coming soon.</span>
          </h1>
          <p className="lede" style={{ margin: 0 }}>
            The open-source build is the whole product — no gated features, no check quotas. Hosted Keyring is
            coming soon: same product, our uptime, backups and support.
          </p>
        </div>
      </Row>

      <Row>
        <div className="cells grid lg:grid-cols-3">
          {TIERS.map((t) => (
            <div key={t.name} className={`cell${t.featured ? " featured grain" : ""}${t.soon ? " hatch" : ""}`} style={{ display: "flex", flexDirection: "column", padding: "32px 28px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <span className="label fg">{t.name}</span>
                {t.soon ? <span className="tag" style={{ borderColor: "var(--a-line-strong)", color: "var(--a-muted)" }}>coming soon</span> : <span className="tag">available now</span>}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 24 }}>
                <span className={`display${t.soon ? " muted" : ""}`} style={{ fontSize: 52, lineHeight: 1 }}>{t.price}</span>
                <span className="muted" style={{ fontSize: 12 }}>{t.soon ? `${t.period} · planned` : t.period}</span>
              </div>
              <p className="muted" style={{ margin: "12px 0 0", fontSize: 13 }}>{t.blurb}</p>
              {t.soon ? (
                <span className="btn block" aria-disabled="true" style={{ marginTop: 24, cursor: "default", color: "var(--a-muted)", borderStyle: "dashed" }}>
                  Coming soon
                </span>
              ) : (
                <a
                  href={t.href}
                  className={`btn block${t.featured ? " primary" : ""}`}
                  style={{ marginTop: 24 }}
                  {...(t.href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                >
                  {t.cta} →
                </a>
              )}
              <div style={{ borderTop: "1px dashed var(--a-line-strong)", margin: "28px 0 20px" }} />
              <ul className="plus">
                {t.features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="dim" style={{ borderTop: "1px solid var(--a-line)", padding: "16px 28px", fontSize: 12 }}>
          {"// "}hosted prices are planned and may change before launch. all prices in usd.
        </div>
      </Row>

      <Row id="faq">
        <SectionHead n="?" label="faq" title="Questions," sub="answered." />
        <div className="cells grid md:grid-cols-2" style={{ borderTop: "1px solid var(--a-line)" }}>
          {FAQS.map((f) => (
            <div key={f.q} className="cell" style={{ padding: "26px 28px" }}>
              <h3 className="display" style={{ fontSize: 19, margin: 0, letterSpacing: "-0.01em" }}>
                <span className="accent" style={{ fontFamily: "var(--a-font-mono)", fontSize: 13, marginRight: 10 }}>&gt;</span>
                {f.q}
              </h3>
              <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>{f.a}</p>
            </div>
          ))}
        </div>
      </Row>

      <Row>
        <div className="grid-bg" style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 24, padding: "88px 20px" }}>
          <h2 className="display" style={{ fontSize: "clamp(2rem, 4vw, 3.2rem)", margin: 0 }}>
            Hosted is coming. <span className="muted">The free tier is the real thing today.</span>
          </h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
            <CopyCommand command="npx @usekeyring/cli dev" />
            <Link className="btn primary" href="/docs/cli">Read the docs →</Link>
          </div>
        </div>
      </Row>
    </AsciiPage>
  );
}
