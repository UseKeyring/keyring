-- 0041 SUPABASE ONE-CLICK CONNECT (integrations + link sessions + key issuance)
--
-- Backs POST /api/v1/integrations/supabase/* : the console drives a
-- CLI-style device login (Supabase token stays in memory, never persisted),
-- then the route orchestrates mirror setup on the customer's project.
-- Apply in the Supabase SQL editor (idempotent).

-- ── Connected projects (status display + disconnect) ───────────────────────
CREATE TABLE IF NOT EXISTS public.supabase_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'supabase',
  project_ref text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'failed')),
  step_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, project_ref)
);

ALTER TABLE public.supabase_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org read integrations" ON public.supabase_integrations;
CREATE POLICY "org read integrations" ON public.supabase_integrations FOR SELECT TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.read')
      OR public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.read')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );
DROP POLICY IF EXISTS "org manage integrations" ON public.supabase_integrations;
CREATE POLICY "org manage integrations" ON public.supabase_integrations FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );
DROP POLICY IF EXISTS "org update integrations" ON public.supabase_integrations;
CREATE POLICY "org update integrations" ON public.supabase_integrations FOR UPDATE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );
DROP POLICY IF EXISTS "org delete integrations" ON public.supabase_integrations;
CREATE POLICY "org delete integrations" ON public.supabase_integrations FOR DELETE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );

-- ── Link sessions (ECDH private key for the device flow, single-use) ───────
-- Holds ONLY the temporary ECDH private key (hex). The Supabase user token
-- itself is never persisted anywhere — session-only by design.
CREATE TABLE IF NOT EXISTS public.supabase_link_sessions (
  session_id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  ecdh_private_hex text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

ALTER TABLE public.supabase_link_sessions ENABLE ROW LEVEL SECURITY;
-- No browser policies on purpose: rows are created/consumed exclusively via
-- the RPCs below (caller's integrations.write scope re-verified each time).

-- ── RPC: stash a link session ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_integration_session_create(
  _hash text, _session text, _priv text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN; END IF;
  IF NOT public.api_key_has_scope(_key, 'integrations.write') THEN RETURN; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN; END IF;
  INSERT INTO public.supabase_link_sessions (session_id, organization_id, ecdh_private_hex)
  VALUES (_session, _org, _priv)
  ON CONFLICT (session_id) DO UPDATE
  SET ecdh_private_hex = EXCLUDED.ecdh_private_hex,
      consumed_at = NULL,
      created_at = now();
END;
$$;

-- ── RPC: consume a link session (single-use, returns priv + org) ───────────
CREATE OR REPLACE FUNCTION public.api_integration_session_consume(_hash text, _session text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'integrations.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT ecdh_private_hex INTO _row FROM public.supabase_link_sessions
  WHERE session_id = _session AND organization_id = _org AND consumed_at IS NULL;
  IF _row IS NULL THEN RETURN NULL; END IF;
  UPDATE public.supabase_link_sessions SET consumed_at = now()
  WHERE session_id = _session;
  RETURN json_build_object('ecdh_private_hex', _row.ecdh_private_hex);
END;
$$;

-- ── RPC: record integration status from the connect route ──────────────────
CREATE OR REPLACE FUNCTION public.api_integration_upsert(
  _hash text, _project_ref text, _status text, _steps jsonb
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'integrations.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _status NOT IN ('pending', 'active', 'failed') THEN
    RAISE EXCEPTION 'invalid_status:%', _status;
  END IF;
  INSERT INTO public.supabase_integrations (organization_id, project_ref, status, step_log, updated_at)
  VALUES (_org, _project_ref, _status, COALESCE(_steps, '[]'::jsonb), now())
  ON CONFLICT (organization_id, project_ref) DO UPDATE
  SET status = EXCLUDED.status, step_log = EXCLUDED.step_log, updated_at = now()
  RETURNING id, project_ref, status INTO _row;
  RETURN json_build_object('id', _row.id, 'project_ref', _row.project_ref, 'status', _row.status);
END;
$$;

-- ── RPC: issue a mirror key (raw value stays server-side, never returned) ──
-- Returns the key ID only. The caller (connect route) keeps the raw value in
-- memory long enough to configure function secrets, then discards it.
CREATE OR REPLACE FUNCTION public.api_issue_mirror_key(
  _hash text, _name text, _key_hash text, _prefix text, _scopes text[]
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'integrations.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.api_keys (organization_id, name, key_hash, prefix, key_type, scopes, created_by)
  VALUES (_org, _name, _key_hash, _prefix, 'secret', _scopes)
  RETURNING id INTO _row;
  RETURN json_build_object('id', _row.id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_integration_session_create(text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_integration_session_consume(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_integration_upsert(text, text, text, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_issue_mirror_key(text, text, text, text, text[]) TO anon, authenticated, service_role;
