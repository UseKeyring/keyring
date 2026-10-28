"use client";

import Link from "next/link";
import { useState } from "react";
import type { WaitlistStatus } from "@/lib/waitlist";
import { normalizeStatus } from "@/lib/waitlist";

type Phase = "idle" | "working" | "done" | "error";

export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<WaitlistStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: React.FormEvent, mode: "join" | "check") => {
    e.preventDefault();
    if (!/.+@.+\..+/.test(email.trim())) {
      setPhase("error");
      setMessage("Enter a valid email address.");
      return;
    }
    setPhase("working");
    setMessage(null);
    try {
      const res =
        mode === "join"
          ? await fetch("/api/waitlist", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ email: email.trim() }),
            })
          : await fetch(`/api/waitlist?email=${encodeURIComponent(email.trim())}`);
      const body = (await res.json()) as { status?: unknown; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Something went wrong.");
      const next = normalizeStatus(body.status);
      setStatus(next);
      setPhase("done");
    } catch (err) {
      setPhase("error");
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    }
  };

  const working = phase === "working";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, width: "100%", maxWidth: 480 }}>
      <div className="label rule">
        <span className="accent">[beta]</span>
        <span>private beta</span>
      </div>
      <div>
        <h1 className="display" style={{ fontSize: "clamp(2.3rem, 4vw, 3.4rem)", margin: 0 }}>
          Get early access <span className="muted">to hosted Keyring.</span>
        </h1>
        <p className="muted" style={{ margin: "12px 0 0" }}>
          Leave your email and we&apos;ll enroll you. Approved emails can sign in and use the hosted console while
          the waitlist is on.
        </p>
      </div>

      <form onSubmit={(e) => void submit(e, status === null ? "join" : "check")} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label htmlFor="waitlist-email" className="sr-only">Email</label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            id="waitlist-email"
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            autoComplete="email"
            style={{ flex: "1 1 220px", width: "auto" }}
          />
          <button type="submit" className="btn primary" disabled={working}>
            {working ? "Working…" : status === "approved" ? "Check again" : status === "pending" ? "Check status" : "Join the waitlist →"}
          </button>
        </div>
        {status === null && (
          <button
            type="button"
            className="linkish muted"
            style={{ alignSelf: "flex-start", fontSize: 12.5 }}
            disabled={working || !email.trim()}
            onClick={(e) => void submit(e, "check")}
          >
            already joined? check your status
          </button>
        )}
      </form>

      {phase === "error" && message && (
        <div role="alert" className="notice bad">{message}</div>
      )}

      {phase === "done" && status === "pending" && (
        <div className="notice">
          <div className="fg">You&apos;re on the list{email.trim() ? ` as ${email.trim()}` : ""}.</div>
          <div className="muted" style={{ marginTop: 4 }}>
            We&apos;ll enroll you soon — this page will let you in once your email is approved.
          </div>
        </div>
      )}

      {phase === "done" && status === "approved" && (
        <div className="notice ok" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="fg">You&apos;re enrolled — welcome in.</div>
          <Link className="btn primary block" href="/auth">Continue to sign in →</Link>
        </div>
      )}

      {phase === "done" && status === "unknown" && (
        <div className="notice" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="muted">No signup found for that email — join the waitlist above.</div>
          <button type="button" className="btn block" onClick={(e) => void submit(e, "join")}>Join now</button>
        </div>
      )}

      <p className="dim" style={{ margin: 0, fontSize: 12 }}>
        {"// "}the open-source build needs no invite: <span className="fg">npx @usekeyring/cli dev</span>
      </p>
    </div>
  );
}
