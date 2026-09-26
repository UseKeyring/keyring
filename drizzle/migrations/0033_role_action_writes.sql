-- 0033 ROLE + ACTION WRITES
--
-- Key-based creation for the Management API so integrators (and demo
-- setup scripts) no longer need the dashboard for the first role/action.
-- Adds built-in scopes `roles.write` + `actions.write` and two idempotent
-- SECURITY DEFINER functions. Apply in the Supabase SQL editor (idempotent).
--
-- Design (mirrors api_grant_role):
--   - publishable-key client only; per-op auth inside the function via key hash.
--   - customer plane only (scope='customer', key's organization_id).
--   - POST upserts: same slug => update name/description (+ add permissions),
--     so setup scripts are safe to re-run. Never deletes mappings.
--   - api_create_role verifies every permission slug first; unknown slug
--     raises unknown_permission:<slug> with no partial write.

-- ── Scope guard: allow the two new write scopes on secret keys ──────────────
CREATE OR REPLACE FUNCTION public.guard_api_key_scopes()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  _allowed text[] := ARRAY[
    'check',
    'grants.write',
    'roles.read',
    'roles.write',
    'actions.read',
    'actions.write',
    'subject_tokens.write',
    'telemetry.read',
    'telemetry.write'
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

-- ── Backfill: secret keys holding the read scope gain the write sibling ─────
-- Least-privilege upgrade: keys that could already list roles/actions can now
-- also create them. Keys without the read scope gain nothing.
UPDATE public.api_keys
SET scopes = array(SELECT DISTINCT unnest(scopes || ARRAY['roles.write']) ORDER BY 1)
WHERE key_type = 'secret'
  AND 'roles.read' = ANY (scopes)
  AND NOT ('roles.write' = ANY (scopes));

UPDATE public.api_keys
SET scopes = array(SELECT DISTINCT unnest(scopes || ARRAY['actions.write']) ORDER BY 1)
WHERE key_type = 'secret'
  AND 'actions.read' = ANY (scopes)
  AND NOT ('actions.write' = ANY (scopes));

-- ── api_create_permission ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_create_permission(
  _hash text, _slug text, _name text,
  _category text DEFAULT NULL, _description text DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'actions.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;

  IF _slug IS NULL OR btrim(_slug) = '' THEN
    RAISE EXCEPTION 'invalid_slug:slug required';
  END IF;
  IF _slug <> lower(_slug) OR _slug !~ '^[a-z0-9]+[a-z0-9._-]*\.[a-z0-9._-]+$' THEN
    RAISE EXCEPTION 'invalid_slug:%', _slug;
  END IF;
  IF _name IS NULL OR btrim(_name) = '' THEN
    RAISE EXCEPTION 'invalid_name:name required';
  END IF;

  INSERT INTO public.permissions (slug, name, category, description, scope, organization_id)
  VALUES (
    btrim(_slug), btrim(_name),
    COALESCE(NULLIF(btrim(COALESCE(_category, '')), ''), 'General'),
    NULLIF(btrim(COALESCE(_description, '')), ''),
    'customer', _org
  )
  -- Partial unique index permissions_slug_org_uniq carries
  -- WHERE organization_id IS NOT NULL, so the predicate is required here.
  ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL
  DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    description = EXCLUDED.description
  RETURNING slug, name, description, category, created_at INTO _row;

  RETURN json_build_object(
    'slug', _row.slug, 'name', _row.name,
    'description', _row.description, 'category', _row.category,
    'created_at', _row.created_at
  );
END;
$$;

-- ── api_create_role ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_create_role(
  _hash text, _slug text, _name text,
  _description text DEFAULT NULL, _permissions text[] DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
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

  -- Verify every permission slug up front: no partial writes.
  IF _permissions IS NOT NULL AND cardinality(_permissions) > 0 THEN
    FOREACH _perm IN ARRAY _permissions LOOP
      IF _perm IS NULL OR btrim(_perm) = '' THEN
        RAISE EXCEPTION 'unknown_permission:empty';
      END IF;
      SELECT id INTO _pid FROM public.permissions
      WHERE slug = btrim(_perm) AND scope = 'customer' AND organization_id = _org;
      IF _pid IS NULL THEN
        RAISE EXCEPTION 'unknown_permission:%', btrim(_perm);
      END IF;
    END LOOP;
  END IF;

  INSERT INTO public.roles (slug, name, description, scope, organization_id)
  VALUES (
    _slug_norm, btrim(_name),
    NULLIF(btrim(COALESCE(_description, '')), ''),
    'customer', _org
  )
  -- Partial unique index roles_slug_org_uniq carries
  -- WHERE organization_id IS NOT NULL, so the predicate is required here.
  ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL
  DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
  RETURNING id, slug, name, description, created_at INTO _row;
  _rid := _row.id;

  IF _permissions IS NOT NULL AND cardinality(_permissions) > 0 THEN
    FOREACH _perm IN ARRAY _permissions LOOP
      SELECT id INTO _pid FROM public.permissions
      WHERE slug = btrim(_perm) AND scope = 'customer' AND organization_id = _org;
      -- Verified up front, so _pid is never NULL here; the guard above
      -- raises unknown_permission:<slug> with no partial write instead.
      INSERT INTO public.role_permissions (role_id, permission_id, organization_id)
      VALUES (_rid, _pid, _org)
      ON CONFLICT (role_id, permission_id) DO NOTHING;
    END LOOP;
  END IF;

  RETURN json_build_object(
    'slug', _row.slug, 'name', _row.name,
    'description', _row.description, 'created_at', _row.created_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_create_permission(text, text, text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_create_role(text, text, text, text, text[]) TO anon, authenticated, service_role;
