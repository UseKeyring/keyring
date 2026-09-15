"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export type Subscription = {
  user_id: string;
  plan: string;
  status: string;
  provider_subscription_id: string | null;
  provider_customer_id: string | null;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
};

export const isSubscribed = (sub: Subscription | null | undefined) =>
  !!sub && (sub.plan === "pro" || sub.plan === "enterprise") && sub.status === "active";

// supabase-js wraps non-2xx function responses in a generic FunctionsError.
// The edge function already returns a JSON { error } body — dig it out so
// the UI shows the real cause instead of "non-2xx status code".
const readFnError = async (fnError: unknown): Promise<string> => {
  const context = (fnError as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    try {
      const body = (await context.json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      // fall through to generic message
    }
  }
  return fnError instanceof Error ? fnError.message : "Request failed.";
};

/** The caller's own subscription row (null = free / never subscribed). */
export function useMySubscription() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["my_subscription", user?.id],
    enabled: !!user,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("user_subscriptions")
        .select("*")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Subscription | null;
    },
  });
}

/**
 * Starts a Polar checkout for Pro and redirects to it. Mirrors the reference
 * useSponsorCheckout hook: invoke the edge function, follow the returned URL.
 */
export function usePolarCheckout() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCheckout = useCallback(async (returnTo: string) => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fnError } = await getSupabaseBrowserClient().functions.invoke(
        "polar-checkout",
        { body: { plan: "pro", returnTo } },
      );
      if (fnError) throw new Error(await readFnError(fnError));
      const url = (data as { checkoutUrl?: string; error?: string } | null)?.checkoutUrl;
      const apiError = (data as { error?: string } | null)?.error;
      if (apiError) throw new Error(apiError);
      if (!url) throw new Error("Checkout URL not returned by edge function.");
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start checkout.");
      setLoading(false);
    }
  }, []);

  return { startCheckout, loading, error };
}

/** Opens the Polar customer portal for the caller (manage / cancel). */
export function useCustomerPortal() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openPortal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: fnError } = await getSupabaseBrowserClient().functions.invoke(
        "polar-portal",
        { body: {} },
      );
      if (fnError) throw new Error(await readFnError(fnError));
      const url = (data as { portalUrl?: string; error?: string } | null)?.portalUrl;
      const apiError = (data as { error?: string } | null)?.error;
      if (apiError) throw new Error(apiError);
      if (!url) throw new Error("Portal URL not returned by edge function.");
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to open billing portal.");
      setLoading(false);
    }
  }, []);

  return { openPortal, loading, error };
}

export function useInvalidateSubscription() {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: ["my_subscription"] });
  }, [qc]);
}
