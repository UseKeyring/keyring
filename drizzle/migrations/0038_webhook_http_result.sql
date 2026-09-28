-- 0038 OUTBOX HTTP RESULT (Polar-style deliveries table)
--
-- Polar's per-endpoint page shows the HTTP status code per delivery (green
-- 2xx, red otherwise, "Failed" when the request never completed) plus the
-- response body in the expanded row. Our outbox only kept `last_error`, so
-- the Status column had nothing to show. These two columns close the gap;
-- the dispatcher writes them on every attempt ( Polar-style: single attempt,
-- no auto-retry).
-- Apply in the Supabase SQL editor (idempotent).

ALTER TABLE public.webhook_outbox
  ADD COLUMN IF NOT EXISTS http_code integer;

ALTER TABLE public.webhook_outbox
  ADD COLUMN IF NOT EXISTS response text;
