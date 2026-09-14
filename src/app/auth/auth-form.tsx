"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile } from "@/hooks/useOrganization";
import { isWaitlistEnabled, normalizeStatus } from "@/lib/waitlist";
import { WaitlistBlocked, useWaitlistApproved } from "@/components/waitlist-gate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AuthForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const { user } = useAuth();
  const profile = useMyProfile();
  const router = useRouter();
  const gate = useWaitlistApproved(user?.email);
  const gated = gate.enabled && !!user && !gate.approved;

  useEffect(() => {
    if (!user || !profile.isFetched || gated || gate.checking) return;
    router.replace(profile.data?.organization_id ? "/dashboard" : "/onboarding");
  }, [user, profile.isFetched, profile.data?.organization_id, router, gated, gate.checking]);

  // While the waitlist is on, only approved emails may sign in/up.
  // Returns true when the caller may proceed with Supabase auth.
  const checkWaitlist = async (candidate: string): Promise<boolean> => {
    if (!isWaitlistEnabled()) return true;
    const clean = candidate.trim().toLowerCase();
    try {
      const res = await fetch(`/api/waitlist?email=${encodeURIComponent(clean)}`);
      const body = (await res.json()) as { status?: unknown; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not verify waitlist status.");
      const status = normalizeStatus(body.status);
      if (status === "approved") return true;
      if (status === "pending") {
        toast.error("This email is on the waitlist but not enrolled yet.");
      } else {
        // Unknown address: enroll them as pending so approval unlocks them.
        await fetch("/api/waitlist", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: clean }),
        });
        toast.error("You're on the waitlist now — we'll let you in once enrolled.");
      }
      return false;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not verify waitlist status.",
      );
      return false;
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    if (!(await checkWaitlist(email))) {
      setBusy(false);
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/dashboard`,
          data: { full_name: fullName },
        },
      });
      setBusy(false);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Account created. Check your inbox if confirmation is required.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setBusy(false);
      if (error) {
        toast.error(error.message);
        return;
      }
      router.replace("/dashboard");
    }
  };

  const github = async () => {
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: `${window.location.origin}/dashboard` },
    });
    if (error) toast.error("GitHub sign-in failed. Please try again.");
  };

  // OAuth reveals the email only after the provider round-trip — block
  // unapproved users here instead of letting them into the console.
  if (gate.enabled && user && gate.checking) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <span className="type-mono text-ink-muted">checking waitlist…</span>
      </div>
    );
  }
  if (gated) {
    return (
      <main className="min-h-screen bg-canvas">
        <WaitlistBlocked email={user?.email} />
      </main>
    );
  }

  return (
    <div className="flex h-screen w-full items-center justify-center">
      <div className="w-full max-w-md rounded-3xl bg-pillar p-12">
        <div className="mb-8">
          <div className="mb-4 type-eyebrow text-ink-muted">{mode === "signin" ? "Sign in" : "Sign up"}</div>
          <h2 className="type-display-md text-ink-navy">
            {mode === "signin" ? "Welcome to Keyring" : "Create your workspace"}
          </h2>
          <span className="mt-2 block type-body text-ink-muted">
            {mode === "signin"
              ? "Access your roles and grants console."
              : "Create your workspace organization after signing up."}
          </span>
        </div>

        <div className="flex flex-col gap-4">
          <Button variant="secondary" className="w-full" onClick={github} disabled={busy}>
            Continue with GitHub
          </Button>

          <div className="flex w-full flex-row items-center gap-6">
            <div className="grow border-t border-hairline" />
            <div className="type-body-sm text-ink-muted">or</div>
            <div className="grow border-t border-hairline" />
          </div>

          <form onSubmit={submit} className="space-y-4">
            {mode === "signup" && (
              <div className="space-y-2">
                <Label>Full name</Label>
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Ada Lovelace"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Password</Label>
              <Input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Working…" : mode === "signin" ? "Sign in with email" : "Sign up with email"}
            </Button>
          </form>
        </div>

        <p className="mt-6 type-body-sm text-ink-muted">
          {mode === "signin" ? "No account yet?" : "Already have an account?"}{" "}
          <button
            type="button"
            className="text-link"
            onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          >
            {mode === "signin" ? "Create one" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
