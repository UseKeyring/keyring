import Link from "next/link";
import { KeyringMark } from "@keyring/ui/components/keyring-logo";
import { GITHUB_URL } from "@/lib/site";
import { asciiFontVars } from "./ascii-fonts";
import { AsciiField } from "./ascii-field";
import { CopyCommand } from "./copy-command";
import { ThemeToggle } from "./theme-toggle";
import "./ascii.css";

/*
 * Shared shell for every public page in the ASCII system: fonts, railed
 * rows with `+` crosshairs, section heads, nav and footer. Pages compose
 * <AsciiPage> + <Row>; tokens and primitives live in ascii.css.
 */

export { asciiFontVars };

/* A full-bleed row with a railed frame and `+` crosshairs on its bottom edge. */
export function Row({ children, id, className = "" }: { children: React.ReactNode; id?: string; className?: string }) {
  return (
    <div id={id} className="row" style={{ scrollMarginTop: 64 }}>
      <div className={`frame ${className}`}>
        {children}
        <span className="x l" aria-hidden>+</span>
        <span className="x r" aria-hidden>+</span>
      </div>
    </div>
  );
}

export function SectionLabel({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <div className="label rule">
      <span className="accent">[{n}]</span>
      <span>{children}</span>
    </div>
  );
}

export function SectionHead({ n, label, title, sub }: { n: string; label: string; title: string; sub?: string }) {
  return (
    <div className="pad" style={{ paddingBottom: 40 }}>
      <SectionLabel n={n}>{label}</SectionLabel>
      <h2 className="display" style={{ fontSize: "clamp(2rem, 4vw, 3rem)", margin: "28px 0 0", maxWidth: 820 }}>
        {title} {sub && <span className="muted">{sub}</span>}
      </h2>
    </div>
  );
}

export function Nav({ waitlist = false }: { waitlist?: boolean }) {
  return (
    <div className="row navbar" style={{ position: "sticky", top: 0, zIndex: 20 }}>
      <nav className="frame" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 64, padding: "0 20px" }}>
        <Link href="/" className="fg" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <KeyringMark className="h-[18px] w-[18px]" />
          <span style={{ fontFamily: "var(--a-font-display)", fontSize: 18, letterSpacing: "-0.02em" }}>Keyring</span>
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <div className="hidden items-center gap-7 md:flex">
            <Link className="navlink" href="/#how">How it works</Link>
            <Link className="navlink" href="/#open">Open source</Link>
            <Link className="navlink" href="/docs">Docs</Link>
            {!waitlist && (
              <Link className="navlink" href="/pricing" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                Hosted <span className="tag" style={{ fontSize: 9.5, padding: "0 5px" }}>soon</span>
              </Link>
            )}
            <a className="navlink" href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub ↗</a>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ThemeToggle />
            {waitlist ? (
              <Link className="btn primary sm" href="/waitlist">Join waitlist</Link>
            ) : (
              <Link className="btn primary sm" href="/docs/cli">Get started</Link>
            )}
          </div>
        </div>
      </nav>
    </div>
  );
}

export function Footer({ waitlist = false }: { waitlist?: boolean }) {
  const columns = [
    { h: "product", links: [["How it works", "/#how"], ["Docs", "/docs"], ["CLI & local dev", "/docs/cli"]] },
    { h: "open source", links: [["GitHub", GITHUB_URL], ["MIT license", `${GITHUB_URL}/blob/main/LICENSE`], ["npm", "https://www.npmjs.com/package/@usekeyring/cli"]] },
    { h: "for agents", links: [["llms.txt", "/llms.txt"], ["Policy schema", "/schema/policy.json"], ["MCP setup", "/docs/cli#built-for-agents"]] },
    waitlist
      ? { h: "hosted", links: [["Join the waitlist", "/waitlist"]] }
      : { h: "hosted · soon", links: [["Planned pricing", "/pricing"], ["Beta sign in", "/auth"]] },
  ];
  return (
    <footer>
      {/* living ASCII field, inside the rails */}
      <Row>
        <AsciiField height={300} />
      </Row>
      <div className="row" style={{ borderBottom: 0 }}>
        <div className="frame">
          <div className="grid lg:grid-cols-2">
            <div className="pad" style={{ display: "flex", flexDirection: "column", gap: 20, paddingBottom: 48 }}>
              <Link href="/" className="fg" style={{ display: "flex", alignItems: "center", gap: 12, width: "fit-content" }}>
                <KeyringMark className="h-[26px] w-[26px]" />
                <span className="display" style={{ fontSize: 30, letterSpacing: "-0.03em" }}>Keyring</span>
              </Link>
              <p className="muted" style={{ margin: 0, maxWidth: 380 }}>
                Authorization you own. Open source, MIT licensed, free forever — and built so agents get it right the first time.
              </p>
              <div>
                <CopyCommand command="npx @usekeyring/cli dev" />
              </div>
            </div>
            <div className="pad grid grid-cols-2 sm:grid-cols-4" style={{ gap: 24, paddingBottom: 48 }}>
              {columns.map((col) => (
                <div key={col.h}>
                  <div className="label">{col.h}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
                    {col.links.map(([t, href]) => (
                      <a
                        key={t}
                        href={href}
                        className="navlink"
                        style={{ fontSize: 13.5 }}
                        {...(href!.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}
                      >
                        {t}
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="dim" style={{ borderTop: "1px solid var(--a-line)", padding: "16px 24px", fontSize: 12, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <span>© {new Date().getFullYear()} keyring · mit licensed</span>
            <span>made for humans and agents</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

export function AsciiPage({ children, waitlist = false, chrome = true }: { children: React.ReactNode; waitlist?: boolean; chrome?: boolean }) {
  return (
    <main className={`ascii ${asciiFontVars}`} style={{ display: "flex", flexDirection: "column" }}>
      {chrome && <Nav waitlist={waitlist} />}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>{children}</div>
      {chrome && <Footer waitlist={waitlist} />}
    </main>
  );
}
