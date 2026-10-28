import type { Metadata } from "next";
import Link from "next/link";
import { isWaitlistEnabled } from "@/lib/waitlist";
import { GITHUB_URL } from "@/lib/site";
import { HeroIllustration } from "./hero-illustration";
import { TryItIllustration } from "./illustrations";
import { CopyCommand } from "./copy-command";
import { AsciiPage, Row, SectionHead, SectionLabel } from "./ascii-shell";

export const metadata: Metadata = {
  title: "Keyring — open-source authorization for your product",
  description:
    "Roles, permissions and access checks that live in your own Postgres. MIT licensed, free to self-host, built for humans and agents.",
};

// Runtime toggle (WAITLIST) needs per-request rendering; NEXT_PUBLIC_WAITLIST
// alone would work statically, but force-dynamic keeps both vars live.
export const dynamic = "force-dynamic";

const INSTALL = "npx @usekeyring/cli dev";

/* Code tints: four tones from the system, nothing else. */
const f = (s: string) => <span className="fg">{s}</span>;
const a = (s: string) => <span className="accent">{s}</span>;
const o = (s: string) => <span className="ok">{s}</span>;
const d = (s: string) => <span className="dim">{s}</span>;

const STATS = [
  { k: "MIT", v: "licensed, all of it" },
  { k: "$0", v: "to self-host, forever" },
  { k: "1 query", v: "per access check" },
  { k: "0", v: "vendors in your request path" },
];

const STEPS: {
  title: string;
  note: string;
  file: string;
  meta: string;
  code: React.ReactNode;
}[] = [
  {
    title: "Describe your model",
    note: "Actions are what users can do. Roles bundle them. One JSON file in your repo, reviewed like any other change.",
    file: "keyring.policy.json",
    meta: "json",
    code: (
      <>
        {d("{")}
        {"\n  "}
        {f('"actions"')}
        {d(": {")}
        {"\n    "}
        {o('"invoices.read"')}
        {d(":   ")}
        {o('"Read invoices"')}
        {d(",")}
        {"\n    "}
        {o('"invoices.refund"')}
        {d(": ")}
        {o('"Refund invoices"')}
        {"\n  "}
        {d("},")}
        {"\n  "}
        {f('"roles"')}
        {d(": {")}
        {"\n    "}
        {o('"viewer"')}
        {d(":  [")}
        {o('"invoices.read"')}
        {d("],")}
        {"\n    "}
        {o('"finance"')}
        {d(": [")}
        {o('"invoices.*"')}
        {d("]")}
        {"\n  "}
        {d("}")}
        {"\n"}
        {d("}")}
      </>
    ),
  },
  {
    title: "Push it",
    note: "Keyring diffs the file against your database and applies only what changed. Dry-run first, prune when you mean it.",
    file: "terminal",
    meta: "zsh",
    code: (
      <>
        {d("$ ")}
        {f("keyring push")}
        {"\n"}
        {o("+")} create action invoices.read
        {"\n"}
        {o("+")} create action invoices.refund
        {"\n"}
        {o("+")} create role viewer
        {"\n"}
        {o("+")} create role finance
        {"\n\n"}
        {d("$ ")}
        {f("keyring grant finance user_123")}
        {"\n"}
        {o("✓")} user_123 now holds finance
      </>
    ),
  },
  {
    title: "Check access",
    note: "One call, decided inside Postgres. No extra service, no cache to go stale, nothing a client can talk its way past.",
    file: "server.ts",
    meta: "ts",
    code: (
      <>
        {a("import")} {f("{ createKeyring }")} {a("from")}{" "}
        {o('"@usekeyring/sdk/postgres"')}
        {d(";")}
        {"\n\n"}
        {a("const")} {f("keyring")} {d("=")} {f("createKeyring")}
        {d("({")}
        {"\n  "}database{d(",")} {d("// your pg / Neon pool")}
        {"\n  "}apiKey{d(":")} process.env.KEYRING_SECRET_KEY{d(",")}
        {"\n"}
        {d("});")}
        {"\n\n"}
        {a("await")} {f("keyring.assert")}
        {d("(")}user.id{d(", ")}
        {o('"invoices.refund"')}
        {d(");")}
      </>
    ),
  },
];

const REASONS = [
  {
    glyph: "{ MIT }",
    t: "Open, all the way down",
    d: "Schema, API, console, CLI — one MIT repo. Fork it, vendor it, ship it inside a commercial product. No open-core asterisk.",
  },
  {
    glyph: "[ pg ]",
    t: "Lives in your database",
    d: "A schema and a set of functions in your own Postgres. Access data never leaves your infrastructure, and there's no meter running.",
  },
  {
    glyph: ">_ mcp",
    t: "Agents get it first try",
    d: "JSON output, a hint on every error, an MCP server and an AGENTS.md block. Claude and Cursor wire up permissions without guessing.",
  },
];

export default function LandingPage() {
  // Private beta: same page, but hosted CTAs point at /waitlist.
  const waitlist = isWaitlistEnabled();

  return (
    <AsciiPage waitlist={waitlist}>

      {/* hero — copy left, live ASCII flow on a drafting grid right */}
      <Row>
        <div className="cells grid lg:grid-cols-2">
          <div
            className="pad"
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 28,
            }}
          >
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="label"
              style={{
                display: "inline-flex",
                gap: 8,
                alignItems: "center",
                width: "fit-content",
              }}
            >
              <span className="ok">●</span> open source · mit licensed · free
              forever
            </a>
            <h1
              className="display"
              style={{ fontSize: "clamp(2.5rem, 4.3vw, 4.4rem)", margin: 0 }}
            >
              Authorization you own.
            </h1>
            <p className="lede" style={{ margin: 0 }}>
              Roles, permissions and access checks for your product, running in
              your own Postgres. No seats, no per-check bill, no vendor sitting
              between your users and your data.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <CopyCommand command={INSTALL} />
              <a
                className="btn"
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
              >
                Star on GitHub
              </a>
            </div>
            <p className="dim" style={{ margin: 0, fontSize: 12 }}>
              ↳ local database, console and API in one command. nothing to sign
              up for.
            </p>
          </div>
          <div
            className="grid-bg"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "32px 12px",
            }}
          >
            <HeroIllustration />
          </div>
        </div>
      </Row>

      {/* stats strip */}
      <Row>
        <div className="cells grid grid-cols-2 md:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.k} className="cell grain dots" style={{ padding: "22px 24px" }}>
              <div className="display" style={{ fontSize: 30 }}>
                {s.k}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {s.v}
              </div>
            </div>
          ))}
        </div>
      </Row>

      {/* how it works */}
      <Row id="how">
        <SectionHead
          n="01"
          label="how it works"
          title="Three steps."
          sub="That's the whole product."
        />
        <div className="cells" style={{ borderTop: "1px solid var(--a-line)" }}>
          {STEPS.map((s, n) => (
            <div
              key={s.title}
              className="cells grid md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
              style={{ background: "var(--a-line)" }}
            >
              <div className="cell">
                <div className="accent" style={{ fontSize: 12 }}>
                  step_{String(n + 1).padStart(2, "0")}
                </div>
                <h3
                  className="display"
                  style={{
                    fontSize: 24,
                    margin: "10px 0 0",
                    letterSpacing: "-0.02em",
                  }}
                >
                  {s.title}
                </h3>
                <p
                  className="muted"
                  style={{ margin: "10px 0 0", maxWidth: 340, fontSize: 13 }}
                >
                  {s.note}
                </p>
              </div>
              <div className="win">
                <div className="bar">
                  <span>── {s.file}</span>
                  <span className="dim">{s.meta}</span>
                </div>
                <pre className="fg">{s.code}</pre>
              </div>
            </div>
          ))}
        </div>
      </Row>

      {/* open source */}
      <Row id="open">
        <SectionHead
          n="02"
          label="open source"
          title="Free isn't a tier."
          sub="It's the default."
        />
        <div
          className="cells grid md:grid-cols-3"
          style={{ borderTop: "1px solid var(--a-line)" }}
        >
          {REASONS.map((r) => (
            <div
              key={r.t}
              className="cell"
              style={{ padding: "32px 28px 36px" }}
            >
              <div className="accent" style={{ fontSize: 13 }}>
                {r.glyph}
              </div>
              <h3
                className="display"
                style={{
                  fontSize: 21,
                  margin: "22px 0 0",
                  letterSpacing: "-0.015em",
                }}
              >
                {r.t}
              </h3>
              <p className="muted" style={{ margin: "10px 0 0", fontSize: 13 }}>
                {r.d}
              </p>
            </div>
          ))}
        </div>
        <div
          style={{
            borderTop: "1px solid var(--a-line)",
            padding: "18px 28px",
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span className="muted" style={{ fontSize: 12.5 }}>
            <span className="dim">{"// "}</span>
            {waitlist
              ? "rather not run it yourself? hosted keyring is in private beta."
              : "rather not run it yourself? hosted keyring is coming soon."}
          </span>
          <Link href={waitlist ? "/waitlist" : "/pricing"} className="accent" style={{ fontSize: 12.5 }}>
            {waitlist ? "join the waitlist →" : "preview hosted plans →"}
          </Link>
        </div>
      </Row>

      {/* closing — CTA left, live ASCII check flow right */}
      <Row>
        <div className="cells grid lg:grid-cols-2">
          <div
            className="pad"
            style={{
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: 28,
            }}
          >
            <SectionLabel n="03">try it</SectionLabel>
            <h2
              className="display"
              style={{ fontSize: "clamp(2rem, 4vw, 3.2rem)", margin: 0 }}
            >
              Thirty seconds to your first <span className="accent">allow</span>
              .
            </h2>
            <p className="muted" style={{ margin: 0, maxWidth: 420 }}>
              One command boots an embedded Postgres, the console and a local
              API. Every check you run lands in the event log, just like
              production.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <CopyCommand command={INSTALL} />
              <Link className="btn primary" href="/docs/cli">
                Read the docs →
              </Link>
            </div>
          </div>
          <div
            className="grid-bg"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "32px 12px",
              overflowX: "auto",
            }}
          >
            <TryItIllustration />
          </div>
        </div>
      </Row>

    </AsciiPage>
  );
}
