-- 0030 TEMPORARY GRANTS (EXPIRES_AT)
--
-- Lets developers grant a role for a bounded window, e.g. "repo-creator for
-- the next 5 minutes": POST /api/v1/grants { role, subject, ttl_seconds: 300 }
-- After expires_at passes, check() denies and the grant reads as expired.
-- NULL expires_at = permanent (previous behaviour, default).
--
-- Apply in the Supabase SQL editor (idempotent).

-- ── Column ────────────────────────────────────────────────────────────────
ALTER TABLE public.grants
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS grants_expires_at_idx
  ON public.grants (organization_id, expires_at)
  WHERE expires_at IS NOT NULL;

-- Expired rows can never authorize. Permanent rows (NULL) are unaffected.
CREATE OR REPLACE FUNCTION public.has_role(_subject_id uuid, _slug text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.grants g
    JOIN public.roles r ON r.id = g.role_id
    WHERE g.subject_id = _subject_id AND r.slug = _slug
      AND (g.expires_at IS NULL OR g.expires_at > now())
  )
$$;

CREATE OR REPLACE FUNCTION public.has_permission(_subject_id uuid, _perm text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.grants g
    JOIN public.role_permissions rp ON rp.role_id = g.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE g.subject_id = _subject_id AND p.slug = _perm
      AND (g.expires_at IS NULL OR g.expires_at > now())
  )
$$;

CREATE OR REPLACE FUNCTION public.has_permission_for_external(
  _organization_id uuid,
  _subject_id text,
  _perm text
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
      AND s.external_id = _subject_id AND p.slug = _perm
      AND (g.expires_at IS NULL OR g.expires_at > now())
  )
$$;

-- Telemetry snapshot must agree with the check above (else an expired grant
-- would still list its role slug on an allowed=false row).
CREATE OR REPLACE FUNCTION public._granting_role_slugs(_org uuid, _subject text, _perm text)
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
    AND s.external_id = _subject
    AND p.slug = _perm
    AND (g.expires_at IS NULL OR g.expires_at > now())
$$;

-- ── Grant with optional expiry ────────────────────────────────────────────
-- _ttl_seconds wins when both are given. Bounds: ttl 30s–1y, expires_at
-- future and within 1y (prevents far-future accidents, keeps the UX honest).
-- Re-granting the same (role, subject) upserts the expiry so temporary
-- access can be extended without a revoke first. Returns true when a row
-- was inserted or the expiry changed, false when already granted as-is.
DROP FUNCTION IF EXISTS public.api_grant_role(text, text, text, text);

CREATE OR REPLACE FUNCTION public.api_grant_role(
  _hash text, _role text, _subject text,
  _display_name text DEFAULT NULL,
  _expires_at timestamptz DEFAULT NULL,
  _ttl_seconds int DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _rid uuid;
  _sid uuid;
  _exp timestamptz;
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

  IF _ttl_seconds IS NOT NULL THEN
    IF _ttl_seconds < 30 OR _ttl_seconds > 31536000 THEN
      RAISE EXCEPTION 'invalid_ttl_seconds:% (want 30..31536000)', _ttl_seconds;
    END IF;
    _exp := now() + (_ttl_seconds || ' seconds')::interval;
  ELSIF _expires_at IS NOT NULL THEN
    IF _expires_at <= now() THEN
      RAISE EXCEPTION 'expires_at_must_be_future';
    END IF;
    IF _expires_at > now() + interval '366 days' THEN
      RAISE EXCEPTION 'expires_at_too_far (max 1 year)';
    END IF;
    _exp := _expires_at;
  ELSE
    _exp := NULL;
  END IF;

  SELECT public.ensure_subject(_org, _subject, _display_name) INTO _sid;
  INSERT INTO public.grants (organization_id, role_id, subject_id, expires_at)
  VALUES (_org, _rid, _sid, _exp)
  ON CONFLICT (role_id, subject_id) DO UPDATE
    SET expires_at = EXCLUDED.expires_at
    WHERE public.grants.expires_at IS DISTINCT FROM EXCLUDED.expires_at;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_grant_role(text, text, text, text, timestamptz, int)
  TO anon, authenticated, service_role;

-- ── Cleanup helper (console + API key holders) ────────────────────────────
-- Deletes expired rows in the caller's workspace. Console path requires
-- users.manage in the active workspace; API-key path requires grants.write.
CREATE OR REPLACE FUNCTION public.purge_expired_grants(_hash text DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org uuid;
  _key uuid;
  _n int;
BEGIN
  IF _hash IS NOT NULL THEN
    SELECT public._api_key_id(_hash) INTO _key;
    IF _key IS NULL THEN RETURN NULL; END IF;
    IF NOT public.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
    SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  ELSE
    _org := public.my_organization_id();
    IF _org IS NULL THEN RAISE EXCEPTION 'no_active_workspace'; END IF;
    IF NOT public.has_console_permission(auth.uid(), 'users.manage') THEN
      RAISE EXCEPTION 'users_manage_required';
    END IF;
  END IF;
  DELETE FROM public.grants
  WHERE organization_id = _org
    AND expires_at IS NOT NULL
    AND expires_at <= now();
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_expired_grants(text) TO anon, authenticated, service_role;

-- ── Console needs UPDATE to extend/shrink expiry without revoke+regrant ───
DROP POLICY IF EXISTS "org update grants" ON public.grants;
CREATE POLICY "org update grants" ON public.grants FOR UPDATE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  )
  WITH CHECK (
    organization_id = public.my_organization_id()
  );
