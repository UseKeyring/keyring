-- 0044 SUPABASE CONNECT WITHOUT PRE-EXISTING API KEY
--
-- Lets the console run the Supabase device login + project listing on the
-- manager's USER session first; the Keyring secret key (integrations.write)
-- is only required at the final orchestration step. The Supabase user token
-- is handed back to the browser (memory only, never persisted) so the user
-- can pick a project before any Keyring key exists.
-- Apply in the Supabase SQL editor (idempotent).

-- ── RPC: stash a link session for the caller's active workspace ─────────────
CREATE OR REPLACE FUNCTION public.api_integration_session_create_user(
  _session text, _priv text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN; END IF;
  SELECT public.my_organization_id() INTO _org;
  IF _org IS NULL THEN RETURN; END IF;
  IF NOT (
    public.has_console_permission(auth.uid(), 'users.manage')
    OR public.has_console_permission(auth.uid(), 'roles.manage')
  ) THEN RETURN; END IF;
  INSERT INTO public.supabase_link_sessions (session_id, organization_id, ecdh_private_hex, created_by)
  VALUES (_session, _org, _priv, auth.uid())
  ON CONFLICT (session_id) DO UPDATE
  SET ecdh_private_hex = EXCLUDED.ecdh_private_hex,
      organization_id = EXCLUDED.organization_id,
      created_by = EXCLUDED.created_by,
      consumed_at = NULL,
      created_at = now();
END;
$$;

-- ── RPC: consume a user-scoped link session (single-use) ────────────────────
CREATE OR REPLACE FUNCTION public.api_integration_session_consume_user(_session text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid;
  _row record;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;
  SELECT public.my_organization_id() INTO _org;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF NOT (
    public.has_console_permission(auth.uid(), 'users.manage')
    OR public.has_console_permission(auth.uid(), 'roles.manage')
  ) THEN RETURN NULL; END IF;
  SELECT ecdh_private_hex INTO _row FROM public.supabase_link_sessions
  WHERE session_id = _session AND organization_id = _org AND consumed_at IS NULL;
  IF _row IS NULL THEN RETURN NULL; END IF;
  UPDATE public.supabase_link_sessions SET consumed_at = now()
  WHERE session_id = _session;
  RETURN json_build_object('ecdh_private_hex', _row.ecdh_private_hex);
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_integration_session_create_user(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_integration_session_consume_user(text) TO authenticated, service_role;
