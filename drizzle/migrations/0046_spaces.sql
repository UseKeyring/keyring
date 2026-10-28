-- 0046 SPACES (second isolation layer)
--
-- Workspaces that serve many tenants (the integrator's own workspaces/orgs)
-- get a second scope: platform level (no space) plus fully isolated spaces.
--   - Roles, actions AND grants are all space-aware. A subject can hold
--     invoice.create in space "acme" and nothing in space "globex".
--   - Subjects stay org-global identities; grants bind (role, subject, space).
--   - NULL space = platform scope (e.g. a platform admin holding
--     spaces.delete). Checks evaluate EXACTLY the scope passed: no space
--     means platform scope, a slug means that space only. No cross-scope
--     inheritance — spaces stay fully isolated, even from platform keys.
--   - Backward compatible: every existing row has space_id NULL, so it
--     becomes platform scope and all old 3-arg callers keep working.
--
-- New built-in scopes (secret keys only; publishable stays check-only):
--   spaces.read, spaces.write. Least-privilege upgrade: secret keys holding
--   grants.write gain both (same operator persona as the webhooks upgrade).
--
-- Apply in the Supabase SQL editor (idempotent).

-- ── Scope guard: allow spaces.read / spaces.write on secret keys ──────────
CREATE OR REPLACE FUNCTION public.guard_api_key_scopes()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  _allowed text[] := ARRAY[
    'check',
    'grants.write',
    'roles.read',
    'roles.write',
    'spaces.read',
    'spaces.write',
    'actions.read',
    'actions.write',
    'subject_tokens.write',
    'telemetry.read',
    'telemetry.write',
    'webhooks.read',
    'webhooks.write',
    'integrations.write'
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

UPDATE public.api_keys
SET scopes = array(SELECT DISTINCT unnest(scopes || ARRAY['spaces.read', 'spaces.write']) ORDER BY 1)
WHERE key_type = 'secret'
  AND 'grants.write' = ANY (scopes)
  AND NOT ('spaces.write' = ANY (scopes));

-- ── spaces ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  default_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug),
  CONSTRAINT spaces_slug_format_check CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

ALTER TABLE public.spaces ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.spaces TO authenticated;
GRANT ALL ON public.spaces TO service_role;

DROP POLICY IF EXISTS "org read spaces" ON public.spaces;
CREATE POLICY "org read spaces" ON public.spaces FOR SELECT TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.read')
      OR public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.read')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );
DROP POLICY IF EXISTS "org manage spaces" ON public.spaces;
CREATE POLICY "org manage spaces" ON public.spaces FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );
DROP POLICY IF EXISTS "org update spaces" ON public.spaces;
CREATE POLICY "org update spaces" ON public.spaces FOR UPDATE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );
DROP POLICY IF EXISTS "org delete spaces" ON public.spaces;
CREATE POLICY "org delete spaces" ON public.spaces FOR DELETE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );

-- ── space_id columns ──────────────────────────────────────────────────────
ALTER TABLE public.roles
  ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES public.spaces(id) ON DELETE CASCADE;
ALTER TABLE public.permissions
  ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES public.spaces(id) ON DELETE CASCADE;
ALTER TABLE public.role_permissions
  ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES public.spaces(id) ON DELETE CASCADE;
ALTER TABLE public.grants
  ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES public.spaces(id) ON DELETE CASCADE;
ALTER TABLE public.check_events
  ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES public.spaces(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS check_events_space_idx
  ON public.check_events (organization_id, space_id);

-- Uniqueness is now per scope: platform rows (space NULL) keep the old
-- (org, slug) rule; space rows are unique per space.
DROP INDEX IF EXISTS public.roles_slug_org_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS roles_platform_slug_uniq
  ON public.roles (organization_id, slug)
  WHERE organization_id IS NOT NULL AND space_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS roles_space_slug_uniq
  ON public.roles (space_id, slug) WHERE space_id IS NOT NULL;

DROP INDEX IF EXISTS public.permissions_slug_org_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS permissions_platform_slug_uniq
  ON public.permissions (organization_id, slug)
  WHERE organization_id IS NOT NULL AND space_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS permissions_space_slug_uniq
  ON public.permissions (space_id, slug) WHERE space_id IS NOT NULL;

-- Grants: one platform grant + one grant per space per (role, subject).
ALTER TABLE public.grants DROP CONSTRAINT IF EXISTS grants_role_id_subject_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS grants_platform_uniq
  ON public.grants (role_id, subject_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS grants_space_uniq
  ON public.grants (role_id, subject_id, space_id) WHERE space_id IS NOT NULL;

-- ── Scope-integrity triggers ──────────────────────────────────────────────
-- A space always belongs to the row's workspace; role and permission linked
-- together (or granted together) must live in the SAME scope.
CREATE OR REPLACE FUNCTION public.ensure_space_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.space_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.spaces s
    WHERE s.id = NEW.space_id AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'space_mismatch:space belongs to another workspace';
  END IF;
  IF NEW.scope = 'console' AND NEW.space_id IS NOT NULL THEN
    RAISE EXCEPTION 'space_mismatch:console rows cannot live in a space';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS ensure_space_org_roles ON public.roles;
CREATE TRIGGER ensure_space_org_roles
  BEFORE INSERT OR UPDATE OF space_id, organization_id, scope ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.ensure_space_org();
DROP TRIGGER IF EXISTS ensure_space_org_permissions ON public.permissions;
CREATE TRIGGER ensure_space_org_permissions
  BEFORE INSERT OR UPDATE OF space_id, organization_id, scope ON public.permissions
  FOR EACH ROW EXECUTE FUNCTION public.ensure_space_org();

-- role <-> permission links inherit the shared scope; cross-scope links fail.
CREATE OR REPLACE FUNCTION public.set_role_permission_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _r uuid;
  _p uuid;
  _rs uuid;
  _ps uuid;
BEGIN
  SELECT organization_id, space_id INTO _r, _rs FROM public.roles WHERE id = NEW.role_id;
  SELECT organization_id, space_id INTO _p, _ps FROM public.permissions WHERE id = NEW.permission_id;
  IF _r IS NULL AND _p IS NULL THEN
    NEW.organization_id := NULL;
    NEW.space_id := NULL;
  ELSIF _r IS NOT DISTINCT FROM _p AND _r IS NOT NULL
      AND _rs IS NOT DISTINCT FROM _ps THEN
    NEW.organization_id := _r;
    NEW.space_id := _rs;
  ELSE
    RAISE EXCEPTION 'Role and permission must belong to the same workspace and scope';
  END IF;
  RETURN NEW;
END;
$$;

-- Grants carry the caller's scope; the role must live in that same scope.
CREATE OR REPLACE FUNCTION public.set_grant_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _s uuid;
  _r uuid;
  _rs uuid;
BEGIN
  SELECT organization_id INTO _s FROM public.subjects WHERE id = NEW.subject_id;
  SELECT organization_id, space_id INTO _r, _rs FROM public.roles WHERE id = NEW.role_id;
  IF _s IS NULL OR _r IS NULL OR _s IS DISTINCT FROM _r THEN
    RAISE EXCEPTION 'Subject and role must belong to the same workspace';
  END IF;
  IF _rs IS DISTINCT FROM NEW.space_id THEN
    RAISE EXCEPTION 'space_mismatch:role and grant must live in the same scope';
  END IF;
  NEW.organization_id := _s;
  RETURN NEW;
END;
$$;

-- Per-space default role (provisioning inside a space).
CREATE OR REPLACE FUNCTION public.check_space_default_role_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.default_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.roles
    WHERE id = NEW.default_role_id
      AND scope = 'customer'
      AND organization_id = NEW.organization_id
      AND space_id IS NOT DISTINCT FROM NEW.id
  ) THEN
    RAISE EXCEPTION 'invalid_default_role:must be a customer role of this space';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_check_space_default_role_org ON public.spaces;
CREATE TRIGGER trg_check_space_default_role_org
  BEFORE INSERT OR UPDATE OF default_role_id ON public.spaces
  FOR EACH ROW EXECUTE FUNCTION public.check_space_default_role_org();

-- ── Scope resolver (NULL/blank = platform scope) ──────────────────────────
CREATE OR REPLACE FUNCTION public._resolve_space_id(_org uuid, _space text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
BEGIN
  IF _space IS NULL OR btrim(_space) = '' THEN
    RETURN NULL;
  END IF;
  SELECT id INTO _id FROM public.spaces
  WHERE organization_id = _org AND slug = lower(btrim(_space));
  IF _id IS NULL THEN
    RAISE EXCEPTION 'unknown_space:%', btrim(_space);
  END IF;
  RETURN _id;
END;
$$;

-- ── Core checks now take a scope ──────────────────────────────────────────
DROP FUNCTION IF EXISTS public.has_permission_for_external(uuid, text, text);
DROP FUNCTION IF EXISTS public.has_permission_for_external(uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public.has_permission_for_external(uuid, text, text, jsonb, text);
CREATE OR REPLACE FUNCTION public.has_permission_for_external(
  _organization_id uuid,
  _subject_id text,
  _perm text,
  _context jsonb DEFAULT '{}',
  _space text DEFAULT NULL
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.grants g
    JOIN public.roles r ON r.id = g.role_id
    JOIN public.role_permissions rp ON rp.role_id = g.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    JOIN public.subjects s ON s.id = g.subject_id
    WHERE g.organization_id = _organization_id
      AND r.organization_id = _organization_id
      AND s.organization_id = _organization_id
      AND p.organization_id = _organization_id
      AND r.scope = 'customer'
      AND g.space_id IS NOT DISTINCT FROM public._resolve_space_id(_organization_id, _space)
      AND r.space_id IS NOT DISTINCT FROM g.space_id
      AND p.space_id IS NOT DISTINCT FROM g.space_id
      AND s.external_id = _subject_id AND p.slug = _perm
      AND (g.expires_at IS NULL OR g.expires_at > now())
      AND public._abac_condition_matches(
        g.condition, s.attrs, COALESCE(_context, '{}')
      )
  )
$$;

GRANT EXECUTE ON FUNCTION public.has_permission_for_external(uuid, text, text, jsonb, text)
  TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public._granting_role_slugs(uuid, text, text);
DROP FUNCTION IF EXISTS public._granting_role_slugs(uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public._granting_role_slugs(uuid, text, text, jsonb, text);
CREATE OR REPLACE FUNCTION public._granting_role_slugs(_org uuid, _subject text, _perm text, _context jsonb DEFAULT '{}', _space text DEFAULT NULL)
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(DISTINCT r.slug), '{}')
  FROM public.grants g
  JOIN public.roles r ON r.id = g.role_id
  JOIN public.role_permissions rp ON rp.role_id = g.role_id
  JOIN public.permissions p ON p.id = rp.permission_id
  JOIN public.subjects s ON s.id = g.subject_id
  WHERE g.organization_id = _org
    AND r.organization_id = _org
    AND s.organization_id = _org
    AND p.organization_id = _org
    AND r.scope = 'customer'
    AND g.space_id IS NOT DISTINCT FROM public._resolve_space_id(_org, _space)
    AND r.space_id IS NOT DISTINCT FROM g.space_id
    AND p.space_id IS NOT DISTINCT FROM g.space_id
    AND s.external_id = _subject
    AND p.slug = _perm
    AND (g.expires_at IS NULL OR g.expires_at > now())
    AND public._abac_condition_matches(g.condition, s.attrs, COALESCE(_context, '{}'))
$$;

-- ── api_check with scope ──────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.api_check(text, text, text);
DROP FUNCTION IF EXISTS public.api_check(text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.api_check(text, text, text, jsonb, text);
CREATE OR REPLACE FUNCTION public.api_check(_hash text, _subject text, _perm text, _context jsonb DEFAULT '{}', _space text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _allowed boolean;
  _sid uuid;
  _pid uuid;
  _space_id uuid;
  _roles text[];
  _store_as text;
  _telemetry_on boolean;
  _subject_mode text;
  _ctx jsonb;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'check') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  _ctx := COALESCE(_context, '{}');
  IF jsonb_typeof(_ctx) <> 'object' THEN
    RAISE EXCEPTION 'invalid_context (want object)';
  END IF;
  SELECT public._resolve_space_id(_org, _space) INTO _space_id;

  _allowed := public.has_permission_for_external(_org, _subject, _perm, _ctx, _space);

  BEGIN
    SELECT telemetry_enabled, telemetry_subject_mode
      INTO _telemetry_on, _subject_mode
      FROM public.organizations WHERE id = _org;
    IF COALESCE(_telemetry_on, true) THEN
      SELECT id INTO _sid FROM public.subjects
      WHERE organization_id = _org AND external_id = _subject;
      SELECT id INTO _pid FROM public.permissions
      WHERE organization_id = _org AND scope = 'customer' AND slug = _perm
        AND space_id IS NOT DISTINCT FROM _space_id;
      IF _allowed THEN
        SELECT public._granting_role_slugs(_org, _subject, _perm, _ctx, _space) INTO _roles;
      ELSE
        _roles := '{}';
      END IF;
      IF _subject_mode = 'hashed' THEN
        _store_as := encode(digest(_subject, 'sha256'), 'hex');
      ELSE
        _store_as := _subject;
      END IF;
      INSERT INTO public.check_events (
        organization_id, space_id, subject_id, subject_external_id,
        permission_id, permission_slug, matched_role_slugs,
        allowed, api_key_id, event_type, context
      ) VALUES (
        _org, _space_id, _sid, _store_as,
        _pid, _perm, COALESCE(_roles, '{}'),
        _allowed, _key, 'check', _ctx
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN _allowed;
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_check(text, text, text, jsonb, text) TO anon, authenticated, service_role;

-- ── api_grant_role with scope (single DEFAULTed function, no wrappers) ────
DROP FUNCTION IF EXISTS public.api_grant_role(text, text, text, text);
DROP FUNCTION IF EXISTS public.api_grant_role(text, text, text, text, timestamptz, int);
DROP FUNCTION IF EXISTS public.api_grant_role(text, text, text, text, timestamptz, int, jsonb);
DROP FUNCTION IF EXISTS public.api_grant_role(text, text, text, text, timestamptz, int, jsonb, text);
CREATE OR REPLACE FUNCTION public.api_grant_role(
  _hash text, _role text, _subject text,
  _display_name text DEFAULT NULL,
  _expires_at timestamptz DEFAULT NULL,
  _ttl_seconds int DEFAULT NULL,
  _condition jsonb DEFAULT NULL,
  _space text DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _rid uuid;
  _sid uuid;
  _space_id uuid;
  _exp timestamptz;
  _cond jsonb;
  _n int;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT public._resolve_space_id(_org, _space) INTO _space_id;
  SELECT id INTO _rid FROM public.roles
  WHERE slug = _role AND scope = 'customer' AND organization_id = _org
    AND space_id IS NOT DISTINCT FROM _space_id;
  IF _rid IS NULL THEN RAISE EXCEPTION 'unknown_role:%', _role; END IF;

  _cond := COALESCE(_condition, '{}');
  IF jsonb_typeof(_cond) <> 'object' THEN
    RAISE EXCEPTION 'invalid_condition (want object)';
  END IF;
  PERFORM public._abac_condition_matches(_cond, '{}', '{}');

  IF _ttl_seconds IS NOT NULL THEN
    IF _ttl_seconds < 30 OR _ttl_seconds > 31536000 THEN
      RAISE EXCEPTION 'invalid_ttl_seconds:% (want 30..31536000)', _ttl_seconds; END IF;
    _exp := now() + (_ttl_seconds || ' seconds')::interval;
  ELSIF _expires_at IS NOT NULL THEN
    IF _expires_at <= now() THEN RAISE EXCEPTION 'expires_at_must_be_future'; END IF;
    IF _expires_at > now() + interval '366 days' THEN RAISE EXCEPTION 'expires_at_too_far (max 1 year)'; END IF;
    _exp := _expires_at;
  ELSE _exp := NULL; END IF;

  SELECT public.ensure_subject(_org, _subject, _display_name) INTO _sid;
  -- Partial unique indexes need matching arbiters, so the upsert branches.
  IF _space_id IS NULL THEN
    INSERT INTO public.grants (organization_id, role_id, subject_id, expires_at, condition)
    VALUES (_org, _rid, _sid, _exp, _cond)
    ON CONFLICT (role_id, subject_id) WHERE space_id IS NULL DO UPDATE
      SET expires_at = EXCLUDED.expires_at,
          condition = EXCLUDED.condition
      WHERE public.grants.expires_at IS DISTINCT FROM EXCLUDED.expires_at
         OR public.grants.condition IS DISTINCT FROM EXCLUDED.condition;
  ELSE
    INSERT INTO public.grants (organization_id, space_id, role_id, subject_id, expires_at, condition)
    VALUES (_org, _space_id, _rid, _sid, _exp, _cond)
    ON CONFLICT (role_id, subject_id, space_id) WHERE space_id IS NOT NULL DO UPDATE
      SET expires_at = EXCLUDED.expires_at,
          condition = EXCLUDED.condition
      WHERE public.grants.expires_at IS DISTINCT FROM EXCLUDED.expires_at
         OR public.grants.condition IS DISTINCT FROM EXCLUDED.condition;
  END IF;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_grant_role(text, text, text, text, timestamptz, int, jsonb, text)
  TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.api_revoke_grant(text, text, text);
DROP FUNCTION IF EXISTS public.api_revoke_grant(text, text, text, text);
CREATE OR REPLACE FUNCTION public.api_revoke_grant(_hash text, _role text, _subject text, _space text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _rid uuid;
  _sid uuid;
  _space_id uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT public._resolve_space_id(_org, _space) INTO _space_id;
  SELECT id INTO _rid FROM public.roles
  WHERE slug = _role AND scope = 'customer' AND organization_id = _org
    AND space_id IS NOT DISTINCT FROM _space_id;
  IF _rid IS NULL THEN RAISE EXCEPTION 'unknown_role:%', _role; END IF;
  SELECT id INTO _sid FROM public.subjects
  WHERE external_id = _subject AND organization_id = _org;
  IF _sid IS NULL THEN RETURN true; END IF;
  DELETE FROM public.grants
  WHERE role_id = _rid AND subject_id = _sid AND organization_id = _org
    AND space_id IS NOT DISTINCT FROM _space_id;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_revoke_grant(text, text, text, text)
  TO anon, authenticated, service_role;

-- ── Lists + writes take a scope (NULL = platform scope) ────────────────────
DROP FUNCTION IF EXISTS public.api_list_roles(text);
DROP FUNCTION IF EXISTS public.api_list_roles(text, text);
CREATE OR REPLACE FUNCTION public.api_list_roles(_hash text, _space text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _space_id uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'roles.read') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT public._resolve_space_id(_org, _space) INTO _space_id;
  RETURN COALESCE((
    SELECT json_agg(json_build_object(
      'slug', r.slug, 'name', r.name, 'description', r.description,
      'space', s.slug, 'created_at', r.created_at) ORDER BY r.created_at)
    FROM public.roles r LEFT JOIN public.spaces s ON s.id = r.space_id
    WHERE r.scope = 'customer' AND r.organization_id = _org
      AND r.space_id IS NOT DISTINCT FROM _space_id
  ), '[]'::json);
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_list_roles(text, text) TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.api_list_permissions(text);
DROP FUNCTION IF EXISTS public.api_list_permissions(text, text);
CREATE OR REPLACE FUNCTION public.api_list_permissions(_hash text, _space text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _space_id uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'actions.read') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT public._resolve_space_id(_org, _space) INTO _space_id;
  RETURN COALESCE((
    SELECT json_agg(json_build_object(
      'slug', p.slug, 'name', p.name, 'description', p.description,
      'category', p.category, 'space', s.slug, 'created_at', p.created_at) ORDER BY p.category)
    FROM public.permissions p LEFT JOIN public.spaces s ON s.id = p.space_id
    WHERE p.scope = 'customer' AND p.organization_id = _org
      AND p.space_id IS NOT DISTINCT FROM _space_id
  ), '[]'::json);
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_list_permissions(text, text) TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.api_create_permission(text, text, text, text, text);
DROP FUNCTION IF EXISTS public.api_create_permission(text, text, text, text, text, text);
CREATE OR REPLACE FUNCTION public.api_create_permission(
  _hash text, _slug text, _name text,
  _category text DEFAULT NULL, _description text DEFAULT NULL,
  _space text DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _space_id uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'actions.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT public._resolve_space_id(_org, _space) INTO _space_id;

  IF _slug IS NULL OR btrim(_slug) = '' THEN
    RAISE EXCEPTION 'invalid_slug:slug required';
  END IF;
  IF _slug <> lower(_slug) OR _slug !~ '^[a-z0-9]+[a-z0-9._-]*\.[a-z0-9._-]+$' THEN
    RAISE EXCEPTION 'invalid_slug:%', _slug;
  END IF;
  IF _name IS NULL OR btrim(_name) = '' THEN
    RAISE EXCEPTION 'invalid_name:name required';
  END IF;

  IF _space_id IS NULL THEN
    INSERT INTO public.permissions (slug, name, category, description, scope, organization_id, space_id)
    VALUES (
      btrim(_slug), btrim(_name),
      COALESCE(NULLIF(btrim(COALESCE(_category, '')), ''), 'General'),
      NULLIF(btrim(COALESCE(_description, '')), ''),
      'customer', _org, NULL
    )
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND space_id IS NULL
    DO UPDATE SET
      name = EXCLUDED.name,
      category = EXCLUDED.category,
      description = EXCLUDED.description
    RETURNING slug, name, description, category, created_at INTO _row;
  ELSE
    INSERT INTO public.permissions (slug, name, category, description, scope, organization_id, space_id)
    VALUES (
      btrim(_slug), btrim(_name),
      COALESCE(NULLIF(btrim(COALESCE(_category, '')), ''), 'General'),
      NULLIF(btrim(COALESCE(_description, '')), ''),
      'customer', _org, _space_id
    )
    ON CONFLICT (space_id, slug) WHERE space_id IS NOT NULL
    DO UPDATE SET
      name = EXCLUDED.name,
      category = EXCLUDED.category,
      description = EXCLUDED.description
    RETURNING slug, name, description, category, created_at INTO _row;
  END IF;

  RETURN json_build_object(
    'slug', _row.slug, 'name', _row.name,
    'description', _row.description, 'category', _row.category,
    'space', _space, 'created_at', _row.created_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_create_permission(text, text, text, text, text, text)
  TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.api_create_role(text, text, text, text, text[]);
DROP FUNCTION IF EXISTS public.api_create_role(text, text, text, text, text[], text);
CREATE OR REPLACE FUNCTION public.api_create_role(
  _hash text, _slug text, _name text,
  _description text DEFAULT NULL, _permissions text[] DEFAULT NULL,
  _space text DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _space_id uuid;
  _rid uuid;
  _row record;
  _slug_norm text;
  _perm text;
  _pid uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'roles.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT public._resolve_space_id(_org, _space) INTO _space_id;

  IF _slug IS NULL OR btrim(_slug) = '' THEN
    RAISE EXCEPTION 'invalid_slug:slug required';
  END IF;
  _slug_norm := lower(btrim(_slug));
  IF _slug_norm !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'invalid_slug:%', _slug;
  END IF;
  IF _name IS NULL OR btrim(_name) = '' THEN
    RAISE EXCEPTION 'invalid_name:name required';
  END IF;

  IF _permissions IS NOT NULL AND cardinality(_permissions) > 0 THEN
    FOREACH _perm IN ARRAY _permissions LOOP
      IF _perm IS NULL OR btrim(_perm) = '' THEN
        RAISE EXCEPTION 'unknown_permission:empty';
      END IF;
      SELECT id INTO _pid FROM public.permissions
      WHERE slug = btrim(_perm) AND scope = 'customer' AND organization_id = _org
        AND space_id IS NOT DISTINCT FROM _space_id;
      IF _pid IS NULL THEN
        RAISE EXCEPTION 'unknown_permission:%', btrim(_perm);
      END IF;
    END LOOP;
  END IF;

  IF _space_id IS NULL THEN
    INSERT INTO public.roles (slug, name, description, scope, organization_id, space_id)
    VALUES (
      _slug_norm, btrim(_name),
      NULLIF(btrim(COALESCE(_description, '')), ''),
      'customer', _org, NULL
    )
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND space_id IS NULL
    DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
    RETURNING id, slug, name, description, created_at INTO _row;
  ELSE
    INSERT INTO public.roles (slug, name, description, scope, organization_id, space_id)
    VALUES (
      _slug_norm, btrim(_name),
      NULLIF(btrim(COALESCE(_description, '')), ''),
      'customer', _org, _space_id
    )
    ON CONFLICT (space_id, slug) WHERE space_id IS NOT NULL
    DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
    RETURNING id, slug, name, description, created_at INTO _row;
  END IF;
  _rid := _row.id;

  IF _permissions IS NOT NULL AND cardinality(_permissions) > 0 THEN
    FOREACH _perm IN ARRAY _permissions LOOP
      SELECT id INTO _pid FROM public.permissions
      WHERE slug = btrim(_perm) AND scope = 'customer' AND organization_id = _org
        AND space_id IS NOT DISTINCT FROM _space_id;
      INSERT INTO public.role_permissions (role_id, permission_id, organization_id, space_id)
      VALUES (_rid, _pid, _org, _space_id)
      ON CONFLICT (role_id, permission_id) DO NOTHING;
    END LOOP;
  END IF;

  RETURN json_build_object(
    'slug', _row.slug, 'name', _row.name,
    'description', _row.description, 'space', _space, 'created_at', _row.created_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_create_role(text, text, text, text, text[], text)
  TO anon, authenticated, service_role;

-- role_permissions mapping rows carry the shared scope via the trigger above.
-- The plain (role_id, permission_id) unique still holds per scope because a
-- (role, permission) pair can only ever share one scope (enforced above).

-- ── Provision resolves the default role of the requested scope ────────────
DROP FUNCTION IF EXISTS public.api_provision_subject(text, text, text);
DROP FUNCTION IF EXISTS public.api_provision_subject(text, text, text, text);
CREATE OR REPLACE FUNCTION public.api_provision_subject(
  _hash text, _subject text, _display_name text DEFAULT NULL, _space text DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _rid uuid;
  _slug text;
  _spslug text;
  _space_id uuid;
  _sid uuid;
  _n int;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _subject IS NULL OR btrim(_subject) = '' THEN
    RAISE EXCEPTION 'invalid_subject:subject required';
  END IF;
  SELECT public._resolve_space_id(_org, _space) INTO _space_id;

  IF _space_id IS NULL THEN
    SELECT default_role_id INTO _rid FROM public.organizations WHERE id = _org;
  ELSE
    SELECT default_role_id INTO _rid FROM public.spaces WHERE id = _space_id;
  END IF;
  IF _rid IS NULL THEN RAISE EXCEPTION 'no_default_role:set one in workspace Settings'; END IF;
  SELECT slug, (SELECT slug FROM public.spaces WHERE id = _space_id) INTO _slug, _spslug
  FROM public.roles
  WHERE id = _rid AND scope = 'customer' AND organization_id = _org
    AND space_id IS NOT DISTINCT FROM _space_id;
  IF _slug IS NULL THEN RAISE EXCEPTION 'invalid_default_role:re-pick it in workspace Settings'; END IF;

  SELECT public.ensure_subject(_org, btrim(_subject), _display_name) INTO _sid;
  IF _space_id IS NULL THEN
    INSERT INTO public.grants (organization_id, role_id, subject_id)
    VALUES (_org, _rid, _sid)
    ON CONFLICT (role_id, subject_id) WHERE space_id IS NULL DO NOTHING;
  ELSE
    INSERT INTO public.grants (organization_id, space_id, role_id, subject_id)
    VALUES (_org, _space_id, _rid, _sid)
    ON CONFLICT (role_id, subject_id, space_id) WHERE space_id IS NOT NULL DO NOTHING;
  END IF;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN json_build_object('subject', btrim(_subject), 'role', _slug, 'space', _spslug, 'granted', _n = 1);
END;
$$;
GRANT EXECUTE ON FUNCTION public.api_provision_subject(text, text, text, text) TO anon, authenticated, service_role;

-- ── Snapshot + manual events take a scope ─────────────────────────────────
DROP FUNCTION IF EXISTS public.api_get_subject_access(text, text);
DROP FUNCTION IF EXISTS public.api_get_subject_access(text, text, text);
CREATE OR REPLACE FUNCTION public.api_get_subject_access(_hash text, _subject text, _space text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _sid uuid;
  _space_id uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'check') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT public._resolve_space_id(_org, _space) INTO _space_id;
  SELECT id INTO _sid FROM public.subjects
  WHERE organization_id = _org AND external_id = _subject;
  IF _sid IS NULL THEN
    RETURN json_build_object('subject', _subject, 'space', _space,
      'roles', '[]'::json, 'permissions', '[]'::json);
  END IF;
  RETURN json_build_object(
    'subject', _subject,
    'space', _space,
    'roles', COALESCE((
      SELECT json_agg(r.slug ORDER BY r.slug)
      FROM public.grants g JOIN public.roles r ON r.id = g.role_id
      WHERE g.organization_id = _org AND g.subject_id = _sid
        AND r.scope = 'customer'
        AND g.space_id IS NOT DISTINCT FROM _space_id
        AND r.space_id IS NOT DISTINCT FROM _space_id
        AND (g.expires_at IS NULL OR g.expires_at > now())
    ), '[]'::json),
    'permissions', COALESCE((
      SELECT json_agg(DISTINCT p.slug ORDER BY p.slug)
      FROM public.grants g
      JOIN public.role_permissions rp ON rp.role_id = g.role_id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE g.organization_id = _org AND g.subject_id = _sid
        AND p.scope = 'customer'
        AND g.space_id IS NOT DISTINCT FROM _space_id
        AND p.space_id IS NOT DISTINCT FROM _space_id
        AND (g.expires_at IS NULL OR g.expires_at > now())
    ), '[]'::json)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.api_get_subject_access(text, text, text) TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.api_track_event(text, text, text, boolean, jsonb);
DROP FUNCTION IF EXISTS public.api_track_event(text, text, text, boolean, jsonb, text);
CREATE OR REPLACE FUNCTION public.api_track_event(
  _hash text, _subject text, _perm text,
  _allowed boolean DEFAULT NULL,
  _context jsonb DEFAULT '{}',
  _space text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _sid uuid;
  _pid uuid;
  _space_id uuid;
  _roles text[];
  _resolved boolean;
  _store_as text;
  _telemetry_on boolean;
  _subject_mode text;
  _id uuid;
  _ctx jsonb;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'telemetry.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _subject IS NULL OR btrim(_subject) = '' THEN
    RAISE EXCEPTION 'subject_required';
  END IF;
  IF _perm IS NULL OR btrim(_perm) = '' THEN
    RAISE EXCEPTION 'permission_required';
  END IF;
  _ctx := COALESCE(_context, '{}');
  SELECT public._resolve_space_id(_org, _space) INTO _space_id;

  SELECT telemetry_enabled, telemetry_subject_mode
    INTO _telemetry_on, _subject_mode
    FROM public.organizations WHERE id = _org;
  IF NOT COALESCE(_telemetry_on, true) THEN
    RAISE EXCEPTION 'telemetry_disabled';
  END IF;

  SELECT id INTO _sid FROM public.subjects
  WHERE organization_id = _org AND external_id = _subject;
  SELECT id INTO _pid FROM public.permissions
  WHERE organization_id = _org AND scope = 'customer' AND slug = _perm
    AND space_id IS NOT DISTINCT FROM _space_id;

  IF _allowed IS NULL THEN
    _resolved := public.has_permission_for_external(_org, _subject, _perm, _ctx, _space);
  ELSE
    _resolved := _allowed;
  END IF;
  IF _resolved THEN
    SELECT public._granting_role_slugs(_org, _subject, _perm, _ctx, _space) INTO _roles;
  ELSE
    _roles := '{}';
  END IF;
  IF _subject_mode = 'hashed' THEN
    _store_as := encode(digest(_subject, 'sha256'), 'hex');
  ELSE
    _store_as := _subject;
  END IF;

  INSERT INTO public.check_events (
    organization_id, space_id, subject_id, subject_external_id,
    permission_id, permission_slug, matched_role_slugs,
    allowed, api_key_id, event_type, context
  ) VALUES (
    _org, _space_id, _sid, _store_as,
    _pid, _perm, COALESCE(_roles, '{}'),
    _resolved, _key, 'custom', _ctx
  ) RETURNING id INTO _id;
  RETURN _id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_track_event(text, text, text, boolean, jsonb, text)
  TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.purge_expired_grants(text);
DROP FUNCTION IF EXISTS public.purge_expired_grants(text, text);
CREATE OR REPLACE FUNCTION public.purge_expired_grants(_hash text, _space text DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid;
  _key uuid;
  _space_id uuid;
  _n int;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  SELECT public._resolve_space_id(_org, _space) INTO _space_id;
  DELETE FROM public.grants
  WHERE organization_id = _org
    AND (_space IS NULL OR space_id IS NOT DISTINCT FROM _space_id)
    AND expires_at IS NOT NULL
    AND expires_at <= now();
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_expired_grants(text, text) TO anon, authenticated, service_role;

-- ── Space CRUD RPCs (key-authed, org-scoped) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.api_create_space(
  _hash text, _slug text, _name text, _description text DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'spaces.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _slug IS NULL OR btrim(_slug) = '' THEN
    RAISE EXCEPTION 'invalid_slug:slug required';
  END IF;
  IF lower(btrim(_slug)) !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'invalid_slug:%', _slug;
  END IF;
  IF _name IS NULL OR btrim(_name) = '' THEN
    RAISE EXCEPTION 'invalid_name:name required';
  END IF;
  INSERT INTO public.spaces (organization_id, slug, name, description)
  VALUES (_org, lower(btrim(_slug)), btrim(_name),
    NULLIF(btrim(COALESCE(_description, '')), ''))
  ON CONFLICT (organization_id, slug) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description
  RETURNING id, slug, name, description, created_at INTO _row;
  RETURN json_build_object(
    'id', _row.id, 'slug', _row.slug, 'name', _row.name,
    'description', _row.description, 'created_at', _row.created_at
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.api_create_space(text, text, text, text)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.api_list_spaces(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'spaces.read') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  RETURN COALESCE((
    SELECT json_agg(json_build_object(
      'id', id, 'slug', slug, 'name', name,
      'description', description, 'created_at', created_at
    ) ORDER BY created_at)
    FROM public.spaces WHERE organization_id = _org
  ), '[]'::json);
END;
$$;
GRANT EXECUTE ON FUNCTION public.api_list_spaces(text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.api_delete_space(_hash text, _space text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _space_id uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'spaces.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT public._resolve_space_id(_org, _space) INTO _space_id;
  IF _space_id IS NULL THEN RAISE EXCEPTION 'space_required'; END IF;
  -- Cascades to space roles, permissions, links, grants (FK ON DELETE CASCADE).
  DELETE FROM public.spaces WHERE id = _space_id AND organization_id = _org;
  RETURN true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.api_delete_space(text, text) TO anon, authenticated, service_role;

-- ── Webhook payloads carry the scope ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trg_grants_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _event text;
  _payload jsonb;
  _role_slug text;
  _subject_ext text;
  _space_slug text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    _event := 'grant.created';
  ELSIF TG_OP = 'DELETE' THEN
    _event := 'grant.deleted';
  ELSE
    _event := 'grant.updated';
  END IF;
  SELECT slug INTO _role_slug FROM public.roles WHERE id = COALESCE(NEW.role_id, OLD.role_id);
  SELECT external_id INTO _subject_ext FROM public.subjects WHERE id = COALESCE(NEW.subject_id, OLD.subject_id);
  SELECT slug INTO _space_slug FROM public.spaces WHERE id = COALESCE(NEW.space_id, OLD.space_id);
  _payload := jsonb_build_object(
    'subject', _subject_ext,
    'role', _role_slug,
    'space', _space_slug,
    'expires_at', COALESCE(NEW.expires_at, OLD.expires_at),
    'grant_id', COALESCE(NEW.id, OLD.id)
  );
  PERFORM public.enqueue_webhook_event(COALESCE(NEW.organization_id, OLD.organization_id), _event, _payload);
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_roles_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _event text;
  _space_slug text;
BEGIN
  IF TG_OP = 'INSERT' THEN _event := 'role.created';
  ELSIF TG_OP = 'DELETE' THEN _event := 'role.deleted';
  ELSE _event := 'role.updated';
  END IF;
  IF COALESCE(NEW.scope, OLD.scope) <> 'customer' THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT slug INTO _space_slug FROM public.spaces WHERE id = COALESCE(NEW.space_id, OLD.space_id);
  PERFORM public.enqueue_webhook_event(
    COALESCE(NEW.organization_id, OLD.organization_id), _event,
    jsonb_build_object(
      'role', COALESCE(NEW.slug, OLD.slug),
      'name', COALESCE(NEW.name, OLD.name),
      'space', _space_slug
    )
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_permissions_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _event text;
  _space_slug text;
BEGIN
  IF TG_OP = 'INSERT' THEN _event := 'permission.created';
  ELSIF TG_OP = 'DELETE' THEN _event := 'permission.deleted';
  ELSE _event := 'permission.updated';
  END IF;
  IF COALESCE(NEW.scope, OLD.scope) <> 'customer' THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT slug INTO _space_slug FROM public.spaces WHERE id = COALESCE(NEW.space_id, OLD.space_id);
  PERFORM public.enqueue_webhook_event(
    COALESCE(NEW.organization_id, OLD.organization_id), _event,
    jsonb_build_object(
      'permission', COALESCE(NEW.slug, OLD.slug),
      'name', COALESCE(NEW.name, OLD.name),
      'category', COALESCE(NEW.category, OLD.category),
      'space', _space_slug
    )
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════════
-- § VERIFICATION (read the output after running)
-- ══════════════════════════════════════════════════════════════════════════
SELECT 'spaces_table' AS check, count(*) AS count FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'spaces';
SELECT 'space_columns' AS check, table_name AS name FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'space_id'
  AND table_name IN ('roles', 'permissions', 'role_permissions', 'grants', 'check_events', 'spaces')
ORDER BY table_name;
SELECT 'space_functions' AS check, proname AS name FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('_resolve_space_id', 'api_create_space', 'api_list_spaces',
    'api_delete_space', 'ensure_space_org', 'check_space_default_role_org')
ORDER BY proname;
SELECT 'legacy_unique_gone' AS check, count(*) AS count FROM pg_indexes
WHERE schemaname = 'public' AND indexname IN ('roles_slug_org_uniq', 'permissions_slug_org_uniq');
SELECT 'grant_plain_unique_gone' AS check, count(*) AS count FROM pg_constraint
WHERE conname = 'grants_role_id_subject_id_key';
