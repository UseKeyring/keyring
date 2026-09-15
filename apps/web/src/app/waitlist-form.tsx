"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@keyring/ui/components/button";
import { Input } from "@keyring/ui/components/input";
import { Label } from "@keyring/ui/components/label";
import { KeyringMark } from "@keyring/ui/components/keyring-logo";
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

  return (
    <div className="mx-auto w-full max-w-xl">
      <div className="rounded-2xl bg-pillar p-8 md:p-12">
        <div className="flex items-center gap-2.5">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-ink text-canvas">
            <KeyringMark className="h-3 w-3" />
          </span>
          <span className="type-mono text-ink-muted">Private beta</span>
        </div>
        <h1 className="mt-6 text-[clamp(2rem,5vw,3rem)] leading-[1.05] font-normal tracking-[-0.02em] text-ink-navy">
          Get early access
          <br />
          <span className="text-ink-muted">to Keyring.</span>
        </h1>
        <p className="type-body mt-4 text-ink-muted">
          Leave your email and we&apos;ll enroll you. Approved emails can sign
          in and use the app while the waitlist is on.
        </p>

        <form
          className="mt-8"
          onSubmit={(e) => void submit(e, status === null ? "join" : "check")}
        >
          <Label htmlFor="waitlist-email" className="sr-only">
            Email
          </Label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              id="waitlist-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              className="h-12 flex-1 rounded-full px-5"
            />
            <Button
              type="submit"
              size="lg"
              disabled={phase === "working"}
              className="shrink-0 rounded-full"
            >
              {phase === "working"
                ? "Working…"
                : status === "approved"
                  ? "Check again"
                  : status === "pending"
                    ? "Check status"
                    : "Join the waitlist"}
            </Button>
          </div>
          {status === null && (
            <button
              type="button"
              disabled={phase === "working" || !email.trim()}
              onClick={(e) => void submit(e, "check")}
              className="type-body-sm mt-3 cursor-pointer text-ink-muted hover:text-ink disabled:opacity-50"
            >
              Already joined? Check your status
            </button>
          )}
        </form>

        {phase === "error" && message && (
          <p role="alert" className="type-body-sm mt-4 text-red-500">
            {message}
          </p>
        )}

        {phase === "done" && status === "pending" && (
          <div className="mt-6 rounded-2xl border border-hairline bg-canvas p-4">
            <p className="type-body-sm text-ink">
              You&apos;re on the list{email.trim() ? ` as ${email.trim()}` : ""}.
            </p>
            <p className="type-body-sm mt-1 text-ink-muted">
              We&apos;ll enroll you soon — this page will let you in once your
              email is approved.
            </p>
          </div>
        )}

        {phase === "done" && status === "approved" && (
          <div className="mt-6 rounded-2xl border border-hairline bg-canvas p-4">
            <p className="type-body-sm text-ink">You&apos;re enrolled — welcome in.</p>
            <Button asChild className="mt-3 w-full" size="lg">
              <Link href="/auth">Continue to sign in</Link>
            </Button>
          </div>
        )}

        {phase === "done" && status === "unknown" && (
          <div className="mt-6 rounded-2xl border border-hairline bg-canvas p-4">
            <p className="type-body-sm text-ink-muted">
              No signup found for that email — join the waitlist above.
            </p>
            <Button
              type="button"
              variant="secondary"
              className="mt-3 w-full"
              onClick={(e) => void submit(e, "join")}
            >
              Join now
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
