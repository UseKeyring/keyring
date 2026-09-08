"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile } from "@/hooks/useOrganization";
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

  useEffect(() => {
    if (!user || !profile.isFetched) return;
    router.replace(profile.data?.organization_id ? "/dashboard" : "/onboarding");
  }, [user, profile.isFetched, profile.data?.organization_id, router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
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

  return (
    <div className="mx-auto max-w-[480px] px-8 pt-12 pb-24">
      <div className="type-eyebrow text-ink-muted">{mode === "signin" ? "Sign in" : "Sign up"}</div>
      <h1 className="type-h2 mt-2 text-ink-navy" style={{ fontSize: "48px", lineHeight: "60px" }}>
        {mode === "signin" ? "Sign in" : "Create your workspace"}
      </h1>
      <p className="type-body mt-3 text-ink-muted">
        {mode === "signin"
          ? "Access your roles and grants console."
          : "Create your workspace organization after signing up."}
      </p>

      <div className="mt-8 border border-hairline bg-canvas p-8">
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
            {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <div className="type-mono my-5 flex items-center gap-3 text-ink-muted">
          <span className="h-px flex-1 bg-hairline" />
          or
          <span className="h-px flex-1 bg-hairline" />
        </div>

        <Button variant="secondary" className="w-full" onClick={github}>
          Continue with GitHub
        </Button>
      </div>

      <p className="type-mono mt-6 text-ink-muted">
        {mode === "signin" ? "No account yet?" : "Already have an account?"}{" "}
            <button
              type="button"
              className="text-blue-600 dark:text-blue-400"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        >
          {mode === "signin" ? "Create one" : "Sign in"}
        </button>
      </p>
    </div>
  );
}
