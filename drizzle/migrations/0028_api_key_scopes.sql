-- 0028 API KEY SCOPES
--
-- Fine-grained Management API scopes on issued keys (Polar-style).
-- secret / publishable prefixes remain; scopes refine what each key can call.
-- Built-in scopes (not customer action slugs):
--   check, grants.write, roles.read, actions.read, subject_tokens.write
-- Apply in the Supabase SQL editor (idempotent).

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- Backfill legacy keys to previous behavior.
UPDATE public.api_keys
SET scopes = ARRAY[
  'check',
  'grants.write',
  'roles.read',
  'actions.read',
  'subject_tokens.write'
]
WHERE key_type = 'secret'
  AND (scopes IS NULL OR cardinality(scopes) = 0);

UPDATE public.api_keys
SET scopes = ARRAY['check']
WHERE key_type = 'publishable'
  AND (scopes IS NULL OR cardinality(scopes) = 0 OR scopes <> ARRAY['check']);

-- Reject expired keys the same way as revoked ones.
CREATE OR REPLACE FUNCTION public._api_key_id(_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
BEGIN
  UPDATE public.api_keys
  SET last_used_at = now()
  WHERE key_hash = _hash
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())
  RETURNING id INTO _id;
  RETURN _id;
END;
$$;

CREATE OR REPLACE FUNCTION public.api_key_has_scope(_id uuid, _scope text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.api_keys
    WHERE id = _id AND _scope = ANY (scopes)
  );
$$;

CREATE OR REPLACE FUNCTION public.api_key_meta(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _id;
  IF _id IS NULL THEN RETURN NULL; END IF;
  SELECT name, organization_id, key_type, scopes, expires_at INTO _row
  FROM public.api_keys WHERE id = _id;
  RETURN json_build_object(
    'name', _row.name,
    'organization_id', _row.organization_id,
    'key_type', _row.key_type,
    'scopes', COALESCE(to_json(_row.scopes), '[]'::json),
    'expires_at', _row.expires_at
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
  SELECT name, organization_id, key_type, scopes, expires_at INTO _row
  FROM public.api_keys WHERE id = _id;
  RETURN json_build_object(
    'name', _row.name,
    'organization_id', _row.organization_id,
    'key_type', _row.key_type,
    'scopes', COALESCE(to_json(_row.scopes), '[]'::json),
    'expires_at', _row.expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.api_check(_hash text, _subject text, _perm text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'check') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  RETURN public.has_permission_for_external(_org, _subject, _perm);
END;
$$;

CREATE OR REPLACE FUNCTION public.api_grant_role(_hash text, _role text, _subject text, _display_name text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _rid uuid;
  _sid uuid;
  _n int;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
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
  _rid uuid;
  _sid uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
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
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'roles.read') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
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
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'actions.read') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  RETURN COALESCE((
    SELECT json_agg(json_build_object('slug', slug, 'name', name, 'description', description, 'category', category, 'created_at', created_at) ORDER BY category)
    FROM public.permissions WHERE scope = 'customer' AND organization_id = _org
  ), '[]'::json);
END;
$$;

-- Keep publishable keys from gaining write scopes via direct updates.
CREATE OR REPLACE FUNCTION public.guard_api_key_scopes()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  _allowed text[] := ARRAY[
    'check',
    'grants.write',
    'roles.read',
    'actions.read',
    'subject_tokens.write'
  ];
  _pub text[] := ARRAY['check'];
  _s text;
BEGIN
  IF NEW.scopes IS NULL THEN
    NEW.scopes := '{}';
  END IF;

  FOREACH _s IN ARRAY NEW.scopes LOOP
    IF NOT (_s = ANY (_allowed)) THEN
      RAISE EXCEPTION 'invalid_api_key_scope:%', _s;
    END IF;
  END LOOP;

  IF NEW.key_type = 'publishable' THEN
    FOREACH _s IN ARRAY NEW.scopes LOOP
      IF NOT (_s = ANY (_pub)) THEN
        RAISE EXCEPTION 'publishable_scope_forbidden:%', _s;
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_api_key_scopes ON public.api_keys;
CREATE TRIGGER trg_guard_api_key_scopes
  BEFORE INSERT OR UPDATE OF scopes, key_type ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.guard_api_key_scopes();

GRANT EXECUTE ON FUNCTION public.api_key_meta(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_whoami(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_check(text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_grant_role(text, text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_revoke_grant(text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_list_roles(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_list_permissions(text) TO anon, authenticated, service_role;
