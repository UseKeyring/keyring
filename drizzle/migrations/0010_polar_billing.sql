-- 0010 POLAR BILLING — SUBSCRIPTION-GATED WORKSPACE CREATION
--
-- Creating a workspace requires an active Pro or Enterprise subscription
-- (Polar Merchant of Record). Self-hosters stay free: they run their own
-- database and never touch this hosted console's organizations table.
--
-- How it fits together:
--   1. Client calls the `polar-checkout` edge function (authed) which
--      creates a Polar checkout for the Pro product and returns its URL.
--      Enterprise is sales-led (mailto on the pricing page) — no product.
--   2. Polar fires webhooks at the `polar-webhook` edge function, which
--      verifies the Standard Webhooks signature, stores the raw event
--      (deduped), upserts billing_customers and syncs user_subscriptions.
--   3. `organizations` INSERT now requires an active subscription, so the
--      gate holds even against direct API calls. The client pre-checks too,
--      for a friendly error.
--   4. `polar-portal` edge function opens the Polar customer portal so
--      subscribers can manage/cancel (settings → Billing).
--
-- Polar dashboard setup (do once):
--   - Create the Pro subscription product ($19/mo).
--   - Webhook endpoint: https://<project>.supabase.co/functions/v1/polar-webhook
--     subscribed to subscription.*, checkout.*, order.*, customer.*.
--   - Copy the webhook secret → POLAR_WEBHOOK_SECRET.
--
-- Edge function secrets (supabase secrets set --project-ref <ref>):
--   POLAR_ACCESS_TOKEN, POLAR_ENV=sandbox|production, POLAR_PRO_PRODUCT_ID,
--   POLAR_WEBHOOK_SECRET, POLAR_WEBHOOK_TOLERANCE_SECONDS=300 (optional),
--   APP_URL=https://<your-app>
-- Deploy: supabase functions deploy polar-checkout polar-webhook polar-portal
--   --project-ref <ref>   (sources live in supabase/functions/)
--
-- Every statement below is idempotent. Apply in the Supabase SQL editor.

-- ── Plan catalog ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  code text PRIMARY KEY CHECK (code IN ('free', 'pro', 'enterprise')),
  name text NOT NULL,
  monthly_price_cents integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.subscription_plans (code, name, monthly_price_cents, is_active) VALUES
  ('free', 'Self-hosted', 0, true),
  ('pro', 'Pro', 1900, true),
  ('enterprise', 'Enterprise', 0, true)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name,
  monthly_price_cents = EXCLUDED.monthly_price_cents, is_active = true;

-- ── Subscriber state (written by the webhook, read by RLS + UI) ─────────────
CREATE TABLE IF NOT EXISTS public.user_subscriptions (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'past_due', 'canceled')),
  provider_subscription_id text,
  provider_customer_id text,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.billing_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'polar',
  provider_customer_id text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_customer_id),
  UNIQUE (provider, user_id)
);

CREATE TABLE IF NOT EXISTS public.billing_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'polar',
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS billing_webhook_events_unprocessed_idx
  ON public.billing_webhook_events (processed_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS billing_customers_user_idx
  ON public.billing_customers (user_id);

GRANT SELECT ON public.subscription_plans TO anon, authenticated;
GRANT SELECT ON public.user_subscriptions TO authenticated;
GRANT SELECT ON public.billing_customers TO authenticated;

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read active plans" ON public.subscription_plans;
CREATE POLICY "read active plans" ON public.subscription_plans FOR SELECT TO anon, authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "read own subscription" ON public.user_subscriptions;
CREATE POLICY "read own subscription" ON public.user_subscriptions FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "read own billing customer" ON public.billing_customers;
CREATE POLICY "read own billing customer" ON public.billing_customers FOR SELECT TO authenticated
  USING (user_id = auth.uid());
-- billing_webhook_events: no client policies (edge function uses service_role).

-- ── Sync + gate helpers ─────────────────────────────────────────────────────
-- Upserted by the webhook's service_role client after signature verification.
CREATE OR REPLACE FUNCTION public.sync_subscription(
  p_user_id uuid,
  p_plan text,
  p_status text,
  p_provider_subscription_id text DEFAULT NULL,
  p_provider_customer_id text DEFAULT NULL,
  p_cancel_at_period_end boolean DEFAULT false
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_plan NOT IN ('free', 'pro', 'enterprise') THEN
    RAISE EXCEPTION 'Unknown plan: %', p_plan;
  END IF;
  IF p_status NOT IN ('active', 'past_due', 'canceled') THEN
    RAISE EXCEPTION 'Unknown status: %', p_status;
  END IF;
  INSERT INTO public.user_subscriptions
    (user_id, plan, status, provider_subscription_id, provider_customer_id,
     cancel_at_period_end, updated_at)
  VALUES (p_user_id, p_plan, p_status, p_provider_subscription_id,
    p_provider_customer_id, p_cancel_at_period_end, now())
  ON CONFLICT (user_id) DO UPDATE SET
    plan = EXCLUDED.plan,
    status = EXCLUDED.status,
    provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id,
      public.user_subscriptions.provider_subscription_id),
    provider_customer_id = COALESCE(EXCLUDED.provider_customer_id,
      public.user_subscriptions.provider_customer_id),
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    updated_at = now();
END;
$$;

-- The creation gate: active Pro or Enterprise subscription. SECURITY DEFINER
-- so the organizations INSERT policy can evaluate it under RLS.
CREATE OR REPLACE FUNCTION public.has_active_subscription(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_subscriptions
    WHERE user_id = _user_id
      AND plan IN ('pro', 'enterprise')
      AND status = 'active'
  )
$$;

-- Creating a workspace now requires the subscription. Existing workspaces
-- are untouched (grandfathered); only new INSERTs are gated.
DROP POLICY IF EXISTS "create organizations" ON public.organizations;
CREATE POLICY "subscribed create organizations" ON public.organizations FOR INSERT TO authenticated
  WITH CHECK (public.has_active_subscription(auth.uid()));

-- ── Verification (read the output after running) ────────────────────────────
SELECT 'plans' AS check, code AS name, monthly_price_cents AS price FROM public.subscription_plans ORDER BY code;
SELECT 'policies_on_organizations' AS check, policyname AS name FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'organizations' AND cmd = 'INSERT' ORDER BY policyname;
