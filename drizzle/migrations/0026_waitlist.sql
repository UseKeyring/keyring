-- 0026 WAITLIST
--
-- Private-beta gate: when WAITLIST=true the landing page shows only a
-- waitlist signup, and only approved emails may use the app.
--
-- How to use:
--   1. Set NEXT_PUBLIC_WAITLIST=true (Vercel / client-visible) or
--      WAITLIST=true (server-only) and redeploy / restart.
--   2. Apply this file in the Supabase SQL editor (idempotent).
--   3. Visitors join via POST /api/waitlist (calls join_waitlist).
--   4. Enroll someone via SQL or the Table Editor:
--        UPDATE public.waitlist_emails
--        SET status = 'approved', approved_at = now()
--        WHERE lower(email) = lower('friend@example.com');
--      Approved emails can then sign in and use the app while the
--      waitlist is still on. Set WAITLIST=false to open to everyone.
--
-- Design: the table is locked down (no direct anon/authenticated access);
-- everything goes through SECURITY DEFINER functions granted to anon +
-- authenticated, so visitors can join / check status without leaking the
-- full list. No service_role anywhere in the Next.js stack.

CREATE TABLE IF NOT EXISTS public.waitlist_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_emails_lower_uniq
  ON public.waitlist_emails (lower(email));

ALTER TABLE public.waitlist_emails ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.waitlist_emails TO service_role;

-- Join (idempotent): inserts as pending, returns current status.
CREATE OR REPLACE FUNCTION public.join_waitlist(_email text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _clean text;
  _status text;
BEGIN
  _clean := lower(trim(BOTH ' ' FROM COALESCE(_email, '')));
  IF _clean = '' OR _clean NOT LIKE '%@%.%' OR length(_clean) > 320 THEN
    RAISE EXCEPTION 'Invalid email address';
  END IF;
  INSERT INTO public.waitlist_emails (email, status)
  VALUES (_clean, 'pending')
  ON CONFLICT (lower(email)) DO NOTHING;
  SELECT status INTO _status FROM public.waitlist_emails
  WHERE lower(email) = _clean;
  RETURN COALESCE(_status, 'pending');
END;
$$;

-- Status check: 'pending' | 'approved' | NULL (unknown).
CREATE OR REPLACE FUNCTION public.waitlist_status(_email text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _status text;
BEGIN
  SELECT status INTO _status FROM public.waitlist_emails
  WHERE lower(email) = lower(trim(BOTH ' ' FROM COALESCE(_email, '')));
  RETURN _status;
END;
$$;

-- Boolean gate used by the app: true only for approved emails.
CREATE OR REPLACE FUNCTION public.is_waitlist_approved(_email text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.waitlist_emails
    WHERE lower(email) = lower(trim(BOTH ' ' FROM COALESCE(_email, '')))
      AND status = 'approved'
  )
$$;

GRANT EXECUTE ON FUNCTION public.join_waitlist(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.waitlist_status(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_waitlist_approved(text) TO anon, authenticated, service_role;
