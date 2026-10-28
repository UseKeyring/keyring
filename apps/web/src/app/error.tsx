"use client";

import { useEffect } from "react";
import Link from "next/link";
import "./ascii.css";

// Segment error boundary — renders inside the root layout, so no <html>/<body> here.
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="ascii" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "48px 20px" }}>
      <div className="frame" style={{ width: "100%", maxWidth: 640, border: "1px solid var(--a-line)" }}>
        <div className="grid-bg" style={{ padding: "48px 32px", display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="label rule">
            <span className="bad">[500]</span>
            <span>unexpected error</span>
          </div>
          <h1 className="display" style={{ fontSize: "clamp(2rem, 4vw, 2.8rem)", margin: 0 }}>
            Something went wrong.
          </h1>
          <div className="notice bad">
            <span className="dim">&gt; </span>
            {error.digest ? `error digest ${error.digest}` : "the page threw while rendering — try again."}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="button" className="btn primary" onClick={() => reset()}>Retry</button>
            <Link className="btn" href="/">Go home</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
