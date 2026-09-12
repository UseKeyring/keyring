-- 0007 API FUNCTIONS (NO SERVICE KEY)
--
-- The management API authenticates with issued API keys over the publishable
-- key only. Each function below takes the key's SHA-256 hex, validates it
-- itself (revoked keys return NULL, which routes map to 401), and runs
-- SECURITY DEFINER so no service_role key exists anywhere in the stack.
-- Apply in the Supabase SQL editor.

-- Resolve + touch a key. NULL = unknown or revoked.
CREATE OR REPLACE FUNCTION public._api_key_id(_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
BEGIN
  UPDATE public.api_keys
  SET last_used_at = now()
  WHERE key_hash = _hash AND revoked_at IS NULL
  RETURNING id INTO _id;
  RETURN _id;
END;
$$;

-- Who holds this key (doubles as a validator).
CREATE OR REPLACE FUNCTION public.api_whoami(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _id;
  IF _id IS NULL THEN RETURN NULL; END IF;
  SELECT name, organization_id INTO _row
  FROM public.api_keys WHERE id = _id;
  RETURN json_build_object('name', _row.name, 'organization_id', _row.organization_id);
END;
$$;

-- Read check. NULL = bad key.
CREATE OR REPLACE FUNCTION public.api_check(_hash text, _subject text, _perm text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _id;
  IF _id IS NULL THEN RETURN NULL; END IF;
  RETURN public.has_permission_for_external(_subject, _perm);
END;
$$;

-- Grant a customer role (auto-provisions the subject, idempotent).
-- Returns true when a new grant was created, false when it already existed,
-- NULL on bad key. Raises unknown_role:<slug> for unknown customer roles.
CREATE OR REPLACE FUNCTION public.api_grant_role(_hash text, _role text, _subject text, _display_name text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
  _rid uuid;
  _sid uuid;
  _n int;
BEGIN
  SELECT public._api_key_id(_hash) INTO _id;
  IF _id IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO _rid FROM public.roles WHERE slug = _role AND scope = 'customer';
  IF _rid IS NULL THEN RAISE EXCEPTION 'unknown_role:%', _role; END IF;
  SELECT public.ensure_subject(_subject, _display_name) INTO _sid;
  INSERT INTO public.grants (role_id, subject_id)
  VALUES (_rid, _sid)
  ON CONFLICT (role_id, subject_id) DO NOTHING;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END;
$$;

-- Revoke a customer role (idempotent, always true on valid key).
CREATE OR REPLACE FUNCTION public.api_revoke_grant(_hash text, _role text, _subject text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
  _rid uuid;
  _sid uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _id;
  IF _id IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO _rid FROM public.roles WHERE slug = _role AND scope = 'customer';
  IF _rid IS NULL THEN RAISE EXCEPTION 'unknown_role:%', _role; END IF;
  SELECT id INTO _sid FROM public.subjects WHERE external_id = _subject;
  IF _sid IS NULL THEN RETURN true; END IF;
  DELETE FROM public.grants WHERE role_id = _rid AND subject_id = _sid;
  RETURN true;
END;
$$;

-- Discovery (customer plane only — console rows can never leak).
CREATE OR REPLACE FUNCTION public.api_list_roles(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _id;
  IF _id IS NULL THEN RETURN NULL; END IF;
  RETURN COALESCE((
    SELECT json_agg(json_build_object('slug', slug, 'name', name, 'description', description, 'created_at', created_at) ORDER BY created_at)
    FROM public.roles WHERE scope = 'customer'
  ), '[]'::json);
END;
$$;

CREATE OR REPLACE FUNCTION public.api_list_permissions(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _id;
  IF _id IS NULL THEN RETURN NULL; END IF;
  RETURN COALESCE((
    SELECT json_agg(json_build_object('slug', slug, 'name', name, 'description', description, 'category', category, 'created_at', created_at) ORDER BY category)
    FROM public.permissions WHERE scope = 'customer'
  ), '[]'::json);
END;
$$;
