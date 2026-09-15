-- Publishable vs secret API keys.
-- secret (kr_sk_live_… / legacy kr_live_…): full Management API + subject-token mint
-- publishable (kr_pk_live_…): GET /api/v1/check only (subject bound by JWT in the app layer)

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS key_type text NOT NULL DEFAULT 'secret';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_keys_key_type_check'
  ) THEN
    ALTER TABLE public.api_keys
      ADD CONSTRAINT api_keys_key_type_check
      CHECK (key_type IN ('secret', 'publishable'));
  END IF;
END $$;

UPDATE public.api_keys SET key_type = 'secret' WHERE key_type IS NULL OR key_type = '';

-- Meta for the Next.js layer (type gates + subject-token org binding).
CREATE OR REPLACE FUNCTION public.api_key_meta(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _id;
  IF _id IS NULL THEN RETURN NULL; END IF;
  SELECT name, organization_id, key_type INTO _row
  FROM public.api_keys WHERE id = _id;
  RETURN json_build_object(
    'name', _row.name,
    'organization_id', _row.organization_id,
    'key_type', _row.key_type
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.api_whoami(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _id;
  IF _id IS NULL THEN RETURN NULL; END IF;
  SELECT name, organization_id, key_type INTO _row
  FROM public.api_keys WHERE id = _id;
  RETURN json_build_object(
    'name', _row.name,
    'organization_id', _row.organization_id,
    'key_type', _row.key_type
  );
END;
$$;

-- Secret-only RPCs: publishable keys resolve as unauthorized (NULL).
CREATE OR REPLACE FUNCTION public.api_grant_role(_hash text, _role text, _subject text, _display_name text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _type text;
  _rid uuid;
  _sid uuid;
  _n int;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  SELECT organization_id, key_type INTO _org, _type FROM public.api_keys WHERE id = _key;
  IF _org IS NULL OR _type IS DISTINCT FROM 'secret' THEN RETURN NULL; END IF;
  SELECT id INTO _rid FROM public.roles
  WHERE slug = _role AND scope = 'customer' AND organization_id = _org;
  IF _rid IS NULL THEN RAISE EXCEPTION 'unknown_role:%', _role; END IF;
  SELECT public.ensure_subject(_org, _subject, _display_name) INTO _sid;
  INSERT INTO public.grants (organization_id, role_id, subject_id)
  VALUES (_org, _rid, _sid)
  ON CONFLICT (role_id, subject_id) DO NOTHING;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.api_revoke_grant(_hash text, _role text, _subject text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _type text;
  _rid uuid;
  _sid uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  SELECT organization_id, key_type INTO _org, _type FROM public.api_keys WHERE id = _key;
  IF _org IS NULL OR _type IS DISTINCT FROM 'secret' THEN RETURN NULL; END IF;
  SELECT id INTO _rid FROM public.roles
  WHERE slug = _role AND scope = 'customer' AND organization_id = _org;
  IF _rid IS NULL THEN RAISE EXCEPTION 'unknown_role:%', _role; END IF;
  SELECT id INTO _sid FROM public.subjects
  WHERE external_id = _subject AND organization_id = _org;
  IF _sid IS NULL THEN RETURN true; END IF;
  DELETE FROM public.grants
  WHERE role_id = _rid AND subject_id = _sid AND organization_id = _org;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.api_list_roles(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _type text;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  SELECT organization_id, key_type INTO _org, _type FROM public.api_keys WHERE id = _key;
  IF _org IS NULL OR _type IS DISTINCT FROM 'secret' THEN RETURN NULL; END IF;
  RETURN COALESCE((
    SELECT json_agg(json_build_object('slug', slug, 'name', name, 'description', description, 'created_at', created_at) ORDER BY created_at)
    FROM public.roles WHERE scope = 'customer' AND organization_id = _org
  ), '[]'::json);
END;
$$;

CREATE OR REPLACE FUNCTION public.api_list_permissions(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _type text;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  SELECT organization_id, key_type INTO _org, _type FROM public.api_keys WHERE id = _key;
  IF _org IS NULL OR _type IS DISTINCT FROM 'secret' THEN RETURN NULL; END IF;
  RETURN COALESCE((
    SELECT json_agg(json_build_object('slug', slug, 'name', name, 'description', description, 'category', category, 'created_at', created_at) ORDER BY category)
    FROM public.permissions WHERE scope = 'customer' AND organization_id = _org
  ), '[]'::json);
END;
$$;

-- api_check stays available for both key types (publishable path binds subject via JWT in the app).
CREATE OR REPLACE FUNCTION public.api_check(_hash text, _subject text, _perm text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  RETURN public.has_permission_for_external(_org, _subject, _perm);
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_key_meta(text) TO anon, authenticated, service_role;
