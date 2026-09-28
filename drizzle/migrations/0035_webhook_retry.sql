-- 0035 WEBHOOK DELIVERY RETRY (client redeliver)
--
-- Lets org managers retry a failed/pending delivery straight from the
-- console (Polar-style "Redeliver" button). The dispatcher (service_role)
-- bypasses RLS and is unaffected; browser sessions (auth.uid() present) may
-- only flip a delivery back to pending with a fresh next_retry_at.
--
-- Guard trigger enforces the column whitelist so a client can never rewrite
-- history (event, payload, endpoint_id, timestamps) — only requeue.
-- Apply in the Supabase SQL editor (idempotent).

DROP POLICY IF EXISTS "org retry deliveries" ON public.webhook_outbox;
CREATE POLICY "org retry deliveries" ON public.webhook_outbox FOR UPDATE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  )
  WITH CHECK (
    organization_id = public.my_organization_id()
    AND status = 'pending'
  );

CREATE OR REPLACE FUNCTION public.guard_outbox_retry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Dispatcher path (service_role, no session user): unrestricted.
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  -- Client path: only requeue fields may change, and only back to pending.
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
    OR NEW.event IS DISTINCT FROM OLD.event
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
    RAISE EXCEPTION 'outbox_retry_forbidden:only requeue fields may change';
  END IF;
  IF NEW.status <> 'pending' THEN
    RAISE EXCEPTION 'outbox_retry_forbidden:status must return to pending';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_outbox_retry ON public.webhook_outbox;
CREATE TRIGGER trg_guard_outbox_retry
  BEFORE UPDATE ON public.webhook_outbox
  FOR EACH ROW EXECUTE FUNCTION public.guard_outbox_retry();
