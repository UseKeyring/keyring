-- 0039 INSTANT DISPATCH KICK (fire webhooks in seconds, not minutes)
--
-- Polling webhook_outbox from cron every minute means up-to-60s delivery
-- lag. This adds an AFTER INSERT trigger that kicks `webhook-dispatch` via
-- pg_net the moment rows land, so deliveries fire within seconds. The
-- per-minute cron stays as a fallback (worker down, missed kick, redeliver).
--
-- Two safety properties, both load-bearing:
--   1. The kick is best-effort. pg_net missing, config missing, worker down —
--      all swallowed. The trigger must NEVER fail the enqueueing write
--      (i.e. your grant/role/subject change).
--   2. The cron key lives in a config table readable only by service_role
--      (RLS enabled, no policies) + this SECURITY DEFINER function. Browser
--      sessions can never read it.
-- Apply in the Supabase SQL editor (idempotent), then insert your row (below).

-- ── Dispatch config (one row, id = 1) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_dispatch_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  url text NOT NULL,
  cron_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.webhook_dispatch_config ENABLE ROW LEVEL SECURITY;
-- Intentionally NO policies: only service_role (bypasses RLS) and SECURITY
-- DEFINER functions can read. Authenticated clients get nothing.

-- ── Best-effort kick ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.kick_webhook_dispatch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, net AS $$
DECLARE
  v_url text;
  v_key text;
  v_enabled boolean;
BEGIN
  SELECT url, cron_key, enabled INTO v_url, v_key, v_enabled
  FROM public.webhook_dispatch_config WHERE id = 1;
  IF NOT FOUND OR NOT v_enabled THEN RETURN NULL; END IF;
  BEGIN
    -- Async: pg_net queues and sends after COMMIT. One kick per statement
    -- (not per row), so a fan-out burst costs a single kick; redundant kicks
    -- are cheap — the dispatcher just finds an empty queue.
    PERFORM net.http_post(
      url := v_url,
      body := '{}'::jsonb,
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Key', v_key)
    );
  EXCEPTION WHEN OTHERS THEN
    -- Best-effort only: cron is the fallback. Never fail the write.
    RETURN NULL;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_kick_webhook_dispatch ON public.webhook_outbox;
CREATE TRIGGER trg_kick_webhook_dispatch
  AFTER INSERT ON public.webhook_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION public.kick_webhook_dispatch();

-- Pending-only drain index for the dispatcher (it no longer gates on
-- next_retry_at and treats `failed` as terminal).
CREATE INDEX IF NOT EXISTS webhook_outbox_pending_drain_idx
  ON public.webhook_outbox (created_at)
  WHERE status = 'pending';

-- ── Enable it (run once, with YOUR values — same key as WEBHOOK_DISPATCH_KEY):
-- INSERT INTO public.webhook_dispatch_config (id, url, cron_key)
-- VALUES (1, 'https://<keyring-project-ref>.supabase.co/functions/v1/webhook-dispatch', '<same WEBHOOK_DISPATCH_KEY>')
-- ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, cron_key = EXCLUDED.cron_key, enabled = true;
