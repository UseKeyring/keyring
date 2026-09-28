-- 0037 OUTBOX CLAIM TRACKING (stuck sending recovery)
--
-- If webhook-dispatch crashes between claiming a row (status=sending) and
-- resolving it, the row would sit in sending forever — the drain query only
-- picks up pending/failed. claimed_at lets each run reclaim rows whose claim
-- expired (> 5 min) back to pending before draining.
-- Apply in the Supabase SQL editor (idempotent).

ALTER TABLE public.webhook_outbox
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS webhook_outbox_stale_claim_idx
  ON public.webhook_outbox (status, claimed_at)
  WHERE status = 'sending';
