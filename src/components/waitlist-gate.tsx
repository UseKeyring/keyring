"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { isWaitlistEnabled, normalizeStatus } from "@/lib/waitlist";
import { Button } from "@/components/ui/button";

/*
 * Waitlist gate (client). While the waitlist is on, only approved emails
 * may use the app. Renders nothing while resolving; when the signed-in
 * user's email is not approved, blocks the wrapped UI with a pending
 * screen instead of signing them out (their seat is kept for enrollment).
 */
export function useWaitlistApproved(email: string | null | undefined): {
  enabled: boolean;
  approved: boolean;
  checking: boolean;
} {
  const enabled = isWaitlistEnabled();
  const [approved, setApproved] = useState(!enabled);
  const [checking, setChecking] = useState(!!enabled && !!email);

  useEffect(() => {
    if (!enabled || !email) {
      setApproved(!enabled);
      setChecking(false);
      return;
    }
    let cancelled = false;
    setChecking(true);
    fetch(`/api/waitlist?email=${encodeURIComponent(email)}`)
      .then(async (res) => {
        const body = (await res.json()) as { status?: unknown };
        if (!cancelled) setApproved(normalizeStatus(body.status) === "approved");
      })
      .catch(() => {
        // Fail closed while the waitlist is on: block on errors so the
        // gate can't be skipped by breaking the status call.
        if (!cancelled) setApproved(false);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, email]);

  return { enabled, approved, checking };
}

export function WaitlistBlocked({ email }: { email?: string | null | undefined }) {
  const { signOut } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-md rounded-2xl bg-pillar p-8 text-center md:p-12">
        <p className="type-mono text-ink-muted">Private beta</p>
        <h1 className="type-display-md mt-4 text-ink-navy">You&apos;re on the waitlist</h1>
        <p className="type-body mt-3 text-ink-muted">
          {email ? (
            <>
              <span className="text-ink">{email}</span> isn&apos;t enrolled yet.{" "}
            </>
          ) : null}
          We&apos;ll let you in as soon as your email is approved — no need to
          create another account.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <Button asChild variant="secondary">
            <Link href="/waitlist">Back to the waitlist</Link>
          </Button>
          <button
            type="button"
            onClick={() => void signOut()}
            className="type-body-sm cursor-pointer text-ink-muted hover:text-ink"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
