import Link from "next/link";
import { AsciiPage, Row } from "./ascii-shell";

const ART = ["  _  _    ___  _  _", " | || |  / _ \\| || |", " | || |_| | | | || |_", " |__   _| | | |__   _|", "    | | | |_| |  | |", "    |_|  \\___/   |_|"].join("\n");

export default function NotFound() {
  return (
    <AsciiPage>
      <Row>
        <div className="grid-bg" style={{ minHeight: "calc(100vh - 64px)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: 24, padding: "72px 20px" }}>
          <pre className="art accent" aria-label="404" style={{ fontSize: 15, color: "var(--a-accent)" }}>{ART}</pre>
          <h1 className="display" style={{ fontSize: "clamp(2rem, 4vw, 3rem)", margin: 0 }}>
            Access denied. <span className="muted">Well — not found.</span>
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            <span className="dim">$ </span>keyring check you this.page <span className="bad">→ 404</span>
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
            <Link className="btn primary" href="/">Go home →</Link>
            <Link className="btn" href="/docs">Read the docs</Link>
          </div>
        </div>
      </Row>
    </AsciiPage>
  );
}
