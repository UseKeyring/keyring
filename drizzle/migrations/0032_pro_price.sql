-- 0032 PRO PRICE $12
--
-- Drops the Pro plan from $19/mo to $12/mo in the plan catalog.
-- Display prices live in the app (pricing page, billing settings,
-- onboarding, new-workspace gate); this keeps the DB seed in sync.
-- NOTE: the actual charge amount lives in Polar — update the Pro product
-- price to $12/mo in the Polar dashboard too (POLAR_PRO_PRODUCT_ID).
--
-- Apply in the Supabase SQL editor (idempotent).

UPDATE public.subscription_plans
SET monthly_price_cents = 1200
WHERE code = 'pro' AND monthly_price_cents IS DISTINCT FROM 1200;
