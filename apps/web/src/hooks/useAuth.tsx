"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";

type AuthState = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  session: null,
  user: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let settled = false;
    const finish = (next: Session | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setSession(next);
      setLoading(false);
    };
    // Never leave the console on "loading…" forever: if the session fetch
    // hangs or rejects, settle unauthenticated so the sign-in redirect runs.
    const timer = setTimeout(() => {
      console.warn("[auth] session fetch timed out, continuing unauthenticated");
      finish(null);
    }, 8000);

    try {
      const supabase = getSupabaseBrowserClient();
      const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
        // Route the initial callback through finish() so a valid session
        // clears the 8s timeout. After settling, keep applying live updates
        // (sign-in / sign-out) directly.
        if (!settled) {
          finish(next);
        } else {
          setSession(next);
          setLoading(false);
        }
      });
      supabase.auth
        .getSession()
        .then(({ data }) => finish(data.session))
        .catch((e) => {
          console.warn("[auth] session fetch failed", e);
          finish(null);
        });
      return () => {
        settled = true;
        clearTimeout(timer);
        sub.subscription.unsubscribe();
      };
    } catch (e) {
      console.warn("[auth] client unavailable", e);
      finish(null);
      return () => {};
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        session,
        user: session?.user ?? null,
        loading,
        signOut: async () => {
          await getSupabaseBrowserClient().auth.signOut();
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
