"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile } from "@/hooks/useOrganization";
import { isWaitlistEnabled, normalizeStatus } from "@/lib/waitlist";
import Link from "next/link";
import { useWaitlistApproved } from "@/components/waitlist-gate";

export function AuthForm() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const { user, signOut } = useAuth();
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
    return <p className="muted">checking waitlist<span className="blink">_</span></p>;
  }
  if (gated) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div className="label"><span className="accent">[beta]</span> private beta</div>
        <h1 className="display" style={{ fontSize: "clamp(2rem, 3.4vw, 2.8rem)", margin: 0 }}>You&apos;re on the waitlist.</h1>
        <div className="notice">
          {user?.email ? <><span className="fg">{user.email}</span> isn&apos;t enrolled yet. </> : null}
          We&apos;ll let you in as soon as your email is approved — no need to create another account.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link className="btn" href="/waitlist">Back to the waitlist</Link>
          <button type="button" className="btn" onClick={() => void signOut()}>Log out</button>
        </div>
      </div>
    );
  }
  const signin = mode === "signin";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, width: "100%", maxWidth: 420 }}>
      <div className="label rule">
        <span className="accent">[{signin ? "→" : "+"}]</span>
        <span>{signin ? "sign in" : "sign up"}</span>
      </div>
      <div>
        <h1 className="display" style={{ fontSize: "clamp(2.2rem, 3.6vw, 3rem)", margin: 0 }}>
          {signin ? "Welcome back." : "Create your account."}
        </h1>
        <p className="muted" style={{ margin: "10px 0 0" }}>
          {signin ? "Hosted Keyring is coming soon — early-access accounts sign in here." : "Hosted Keyring is coming soon — create an account to be first in."}
        </p>
      </div>

      <button type="button" className="btn block" onClick={github} disabled={busy}>
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
        Continue with GitHub
      </button>
      <div className="or">or</div>

      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {!signin && (
          <div className="field">
            <label htmlFor="auth-name">Full name</label>
            <input id="auth-name" className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Ada Lovelace" autoComplete="name" />
          </div>
        )}
        <div className="field">
          <label htmlFor="auth-email">Email</label>
          <input id="auth-email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="auth-password">Password</label>
          <input id="auth-password" className="input" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete={signin ? "current-password" : "new-password"} />
        </div>
        <button type="submit" className="btn primary block" disabled={busy}>
          {busy ? "Working…" : signin ? "Sign in with email →" : "Sign up with email →"}
        </button>
      </form>

      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
        {signin ? "No account yet?" : "Already have an account?"}{" "}
        <button type="button" className="linkish" onClick={() => setMode(signin ? "signup" : "signin")}>
          {signin ? "Create one" : "Sign in"}
        </button>
      </p>
      <p className="dim" style={{ margin: 0, fontSize: 12 }}>
        {"// "}self-hosting? you don&apos;t need an account — run <span className="fg">npx @usekeyring/cli dev</span>.
      </p>
    </div>
  );
}
