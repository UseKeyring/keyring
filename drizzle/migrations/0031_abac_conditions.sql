-- 0031 ABAC CONDITIONS ON GRANTS (+ SUBJECT ATTRS)
--
-- Adds attribute-based access on top of RBAC without breaking it:
--   subjects.attrs jsonb  — per-user attributes, e.g. {"department":"finance","plan":"pro"}
--   grants.condition jsonb — per-grant gate, e.g. {"attr":"plan","in":["pro","enterprise"]}
-- Empty condition {} (default) = unconditional = previous behaviour.
--
-- Condition DSL (JSONB, evaluated in Postgres — a client can never argue):
--   {}                                            always true (default, backward-compat)
--   {"attr":"department","equals":"finance"}       equality (string/number/bool via =)
--   {"attr":"plan","in":["pro","enterprise"]}      membership
--   {"attr":"level","gte":3}                       gt/gte/lt/lte (numeric)
--   {"attr":"region","exists":true}                presence check
--   {"all":[{...},{...}]}                          conjunction
--   {"any":[{...},{...}]}                          disjunction
--   {"not":{...}}                                  negation
-- Attribute lookup: request context wins over stored subject attrs.
--   {"attr":"plan",...,"from":"subject"}  only subjects.attrs
--   {"attr":"plan",...,"from":"context"}  only check-time context
--   omitted "from" (or "either") = context ?? subject attrs.
--
-- Check passes context: has_permission_for_external(org, subject, perm, context)
-- and GET /api/v1/check?context={"plan":"pro"} (or POST body). Old 3-arg
-- calls keep working via the wrapper defaulting context to '{}'.
--
-- Apply in the Supabase SQL editor (idempotent).

-- ── Columns ───────────────────────────────────────────────────────────────
ALTER TABLE public.subjects
  ADD COLUMN IF NOT EXISTS attrs jsonb NOT NULL DEFAULT '{}';

ALTER TABLE public.grants
  ADD COLUMN IF NOT EXISTS condition jsonb NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS subjects_attrs_gin_idx
  ON public.subjects USING gin (attrs);
CREATE INDEX IF NOT EXISTS grants_condition_gin_idx
  ON public.grants USING gin (condition);

-- ── Lookup helper: context wins, then subject attrs ───────────────────────
CREATE OR REPLACE FUNCTION public._abac_lookup(
  _key text, _subject_attrs jsonb, _context jsonb, _from text DEFAULT 'either'
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _from = 'subject' THEN (_subject_attrs -> _key)
    WHEN _from = 'context' THEN (_context -> _key)
    ELSE COALESCE((_context -> _key), (_subject_attrs -> _key))
  END
$$;

-- ── Single-clause evaluator ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._abac_clause_matches(
  _clause jsonb, _subject_attrs jsonb, _context jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  _attr text;
  _from text;
  _actual jsonb;
  _expected jsonb;
  _num double precision;
  _op text;
  _list jsonb;
  _item jsonb;
BEGIN
  IF _clause IS NULL OR _clause = '{}'::jsonb THEN
    RETURN true;
  END IF;

  -- Combinators recurse through the full matcher.
  IF _clause ? 'all' THEN
    FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_clause -> 'all', '[]'::jsonb)) LOOP
      IF NOT public._abac_condition_matches(_item, _subject_attrs, _context) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  IF _clause ? 'any' THEN
    FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_clause -> 'any', '[]'::jsonb)) LOOP
      IF public._abac_condition_matches(_item, _subject_attrs, _context) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;
  IF _clause ? 'not' THEN
    RETURN NOT public._abac_condition_matches(_clause -> 'not', _subject_attrs, _context);
  END IF;

  _attr := _clause ->> 'attr';
  IF _attr IS NULL OR btrim(_attr) = '' THEN
    RETURN false;
  END IF;
  _from := COALESCE(NULLIF(_clause ->> 'from', ''), 'either');
  IF _from NOT IN ('either', 'subject', 'context') THEN
    RAISE EXCEPTION 'invalid_condition_from:%', _from;
  END IF;
  _actual := public._abac_lookup(_attr, COALESCE(_subject_attrs, '{}'), COALESCE(_context, '{}'), _from);

  IF _clause ? 'exists' THEN
    IF (_clause ->> 'exists')::boolean IS TRUE THEN
      RETURN _actual IS NOT NULL;
    ELSE
      RETURN _actual IS NULL;
    END IF;
  END IF;

  IF _actual IS NULL THEN
    RETURN false;
  END IF;

  IF _clause ? 'equals' THEN
    _expected := _clause -> 'equals';
    RETURN _actual = _expected;
  END IF;

  IF _clause ? 'in' THEN
    _list := _clause -> 'in';
    IF jsonb_typeof(_list) <> 'array' THEN
      RAISE EXCEPTION 'invalid_condition_in (want array)';
    END IF;
    FOR _item IN SELECT * FROM jsonb_array_elements(_list) LOOP
      IF _actual = _item THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;

  -- Numeric comparisons: extract as double precision (jsonb numbers only).
  FOR _op IN SELECT unnest(ARRAY['gt', 'gte', 'lt', 'lte']) LOOP
    IF _clause ? _op THEN
      BEGIN
        _num := (_actual #>> '{}')::double precision;
        _expected := _clause -> _op;
      EXCEPTION WHEN OTHERS THEN
        RETURN false;
      END;
      IF jsonb_typeof(_expected) <> 'number' THEN
        RAISE EXCEPTION 'invalid_condition_% (want number)', _op;
      END IF;
      CASE _op
        WHEN 'gt' THEN RETURN _num > (_expected::text)::double precision;
        WHEN 'gte' THEN RETURN _num >= (_expected::text)::double precision;
        WHEN 'lt' THEN RETURN _num < (_expected::text)::double precision;
        WHEN 'lte' THEN RETURN _num <= (_expected::text)::double precision;
      END CASE;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'invalid_condition:% (want all|any|not|equals|in|gt|gte|lt|lte|exists)', _clause;
END;
$$;

CREATE OR REPLACE FUNCTION public._abac_condition_matches(
  _condition jsonb, _subject_attrs jsonb, _context jsonb
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _condition IS NULL OR _condition = '{}'::jsonb THEN true
    ELSE public._abac_clause_matches(_condition, COALESCE(_subject_attrs, '{}'), COALESCE(_context, '{}'))
  END
$$;

-- ── Core checks now take request context ──────────────────────────────────
-- Single 4-arg function with DEFAULT so old 3-arg callers keep working.
-- DROPs first: Postgres forbids CREATE OR REPLACE when the new signature
-- only adds DEFAULTed params over an existing overload, and a stale 3-arg
-- copy would bypass ABAC entirely.
DROP FUNCTION IF EXISTS public.has_permission_for_external(uuid, text, text);
DROP FUNCTION IF EXISTS public.has_permission_for_external(uuid, text, text, jsonb);
CREATE OR REPLACE FUNCTION public.has_permission_for_external(
  _organization_id uuid,
  _subject_id text,
  _perm text,
  _context jsonb DEFAULT '{}'
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
      AND public._abac_condition_matches(
        g.condition, s.attrs, COALESCE(_context, '{}')
      )
  )
$$;

-- DROP clears prior GRANTs; restore default execute rights.
GRANT EXECUTE ON FUNCTION public.has_permission_for_external(uuid, text, text, jsonb)
  TO anon, authenticated, service_role;

-- Telemetry snapshot agrees with the check above for the same context.
DROP FUNCTION IF EXISTS public._granting_role_slugs(uuid, text, text);
DROP FUNCTION IF EXISTS public._granting_role_slugs(uuid, text, text, jsonb);
CREATE OR REPLACE FUNCTION public._granting_role_slugs(_org uuid, _subject text, _perm text, _context jsonb DEFAULT '{}')
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
    AND public._abac_condition_matches(g.condition, s.attrs, COALESCE(_context, '{}'))
$$;

-- ── ensure_subject carries attrs (merge on conflict) ──────────────────────
-- DROP the old 3-arg copy so every caller lands on the attrs-aware version
-- (DEFAULTs keep 2- and 3-arg calls working).
DROP FUNCTION IF EXISTS public.ensure_subject(uuid, text, text);
DROP FUNCTION IF EXISTS public.ensure_subject(uuid, text, text, jsonb);
CREATE OR REPLACE FUNCTION public.ensure_subject(
  _organization_id uuid,
  _external_id text,
  _display_name text DEFAULT NULL,
  _attrs jsonb DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
BEGIN
  IF _organization_id IS NULL THEN
    RAISE EXCEPTION 'Organization is required';
  END IF;
  INSERT INTO public.subjects (organization_id, external_id, display_name, attrs)
  VALUES (_organization_id, _external_id, NULLIF(_display_name, ''), COALESCE(_attrs, '{}'))
  ON CONFLICT (organization_id, external_id) DO UPDATE
    SET display_name = COALESCE(EXCLUDED.display_name, public.subjects.display_name),
        attrs = CASE
          WHEN EXCLUDED.attrs IS NULL OR EXCLUDED.attrs = '{}'::jsonb
          THEN public.subjects.attrs
          ELSE public.subjects.attrs || EXCLUDED.attrs
        END
  RETURNING id INTO _id;
  RETURN _id;
END;
$$;

-- DROP clears prior GRANTs; restore default execute rights.
GRANT EXECUTE ON FUNCTION public.ensure_subject(uuid, text, text, jsonb)
  TO anon, authenticated, service_role;

-- ── api_check with context (DEFAULT keeps old 3-arg callers working) ─────
DROP FUNCTION IF EXISTS public.api_check(text, text, text);
DROP FUNCTION IF EXISTS public.api_check(text, text, text, jsonb);
CREATE OR REPLACE FUNCTION public.api_check(_hash text, _subject text, _perm text, _context jsonb DEFAULT '{}')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _allowed boolean;
  _sid uuid;
  _pid uuid;
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

  _allowed := public.has_permission_for_external(_org, _subject, _perm, _ctx);

  BEGIN
    SELECT telemetry_enabled, telemetry_subject_mode
      INTO _telemetry_on, _subject_mode
      FROM public.organizations WHERE id = _org;
    IF COALESCE(_telemetry_on, true) THEN
      SELECT id INTO _sid FROM public.subjects
      WHERE organization_id = _org AND external_id = _subject;
      SELECT id INTO _pid FROM public.permissions
      WHERE organization_id = _org AND scope = 'customer' AND slug = _perm;
      IF _allowed THEN
        SELECT public._granting_role_slugs(_org, _subject, _perm, _ctx) INTO _roles;
      ELSE
        _roles := '{}';
      END IF;
      IF _subject_mode = 'hashed' THEN
        _store_as := encode(digest(_subject, 'sha256'), 'hex');
      ELSE
        _store_as := _subject;
      END IF;
      INSERT INTO public.check_events (
        organization_id, subject_id, subject_external_id,
        permission_id, permission_slug, matched_role_slugs,
        allowed, api_key_id, event_type, context
      ) VALUES (
        _org, _sid, _store_as,
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

GRANT EXECUTE ON FUNCTION public.api_check(text, text, text, jsonb) TO anon, authenticated, service_role;

-- ── api_grant_role with condition (overload chain preserves old signatures) ─
-- New 7-arg version is authoritative; wrappers delegate with NULL condition.
-- DROPs first: wrappers below reuse the old arities, and Postgres refuses
-- CREATE OR REPLACE when the new copy drops DEFAULTs the old one had.
DROP FUNCTION IF EXISTS public.api_grant_role(text, text, text, text);
DROP FUNCTION IF EXISTS public.api_grant_role(text, text, text, text, timestamptz, int);
DROP FUNCTION IF EXISTS public.api_grant_role(text, text, text, text, timestamptz, int, jsonb);
CREATE OR REPLACE FUNCTION public.api_grant_role(
  _hash text, _role text, _subject text,
  _display_name text DEFAULT NULL,
  _expires_at timestamptz DEFAULT NULL,
  _ttl_seconds int DEFAULT NULL,
  _condition jsonb DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _rid uuid;
  _sid uuid;
  _exp timestamptz;
  _cond jsonb;
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

  _cond := COALESCE(_condition, '{}');
  IF jsonb_typeof(_cond) <> 'object' THEN
    RAISE EXCEPTION 'invalid_condition (want object)';
  END IF;
  -- Fail fast on malformed DSL so a typo can't silently become allow-all/deny-all.
  PERFORM public._abac_condition_matches(_cond, '{}', '{}');

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
  INSERT INTO public.grants (organization_id, role_id, subject_id, expires_at, condition)
  VALUES (_org, _rid, _sid, _exp, _cond)
  ON CONFLICT (role_id, subject_id) DO UPDATE
    SET expires_at = EXCLUDED.expires_at,
        condition = EXCLUDED.condition
    WHERE public.grants.expires_at IS DISTINCT FROM EXCLUDED.expires_at
       OR public.grants.condition IS DISTINCT FROM EXCLUDED.condition;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_grant_role(text, text, text, text, timestamptz, int, jsonb)
  TO anon, authenticated, service_role;

-- Back-compat wrappers (Supabase/PostgREST resolves by arity).
-- DEFAULTs preserved so old 3-arg grant calls keep working.
CREATE OR REPLACE FUNCTION public.api_grant_role(_hash text, _role text, _subject text, _display_name text DEFAULT NULL)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.api_grant_role(_hash, _role, _subject, _display_name, NULL, NULL, NULL)
$$;

CREATE OR REPLACE FUNCTION public.api_grant_role(_hash text, _role text, _subject text, _display_name text DEFAULT NULL, _expires_at timestamptz DEFAULT NULL, _ttl_seconds int DEFAULT NULL)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.api_grant_role(_hash, _role, _subject, _display_name, _expires_at, _ttl_seconds, NULL)
$$;

GRANT EXECUTE ON FUNCTION public.api_grant_role(text, text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_grant_role(text, text, text, text, timestamptz, int) TO anon, authenticated, service_role;

-- ── Subject attrs write path (grants.write; upserts + merges attrs) ───────
CREATE OR REPLACE FUNCTION public.api_set_subject_attrs(
  _hash text, _subject text, _attrs jsonb, _display_name text DEFAULT NULL
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _sid uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _subject IS NULL OR btrim(_subject) = '' THEN
    RAISE EXCEPTION 'subject_required';
  END IF;
  IF _attrs IS NULL OR jsonb_typeof(_attrs) <> 'object' THEN
    RAISE EXCEPTION 'invalid_attrs (want object)';
  END IF;
  SELECT public.ensure_subject(_org, _subject, _display_name, _attrs) INTO _sid;
  -- ensure_subject merges; force exact merge for explicit sets via ||.
  UPDATE public.subjects SET attrs = attrs || _attrs
  WHERE id = _sid;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_set_subject_attrs(text, text, jsonb, text)
  TO anon, authenticated, service_role;

-- ── api_track_event resolves with empty context (ABAC-aware via attrs) ────
-- Manual events keep their stored context; allow-resolution uses subject attrs.
CREATE OR REPLACE FUNCTION public.api_track_event(
  _hash text, _subject text, _perm text,
  _allowed boolean DEFAULT NULL,
  _context jsonb DEFAULT '{}'
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _sid uuid;
  _pid uuid;
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

  SELECT telemetry_enabled, telemetry_subject_mode
    INTO _telemetry_on, _subject_mode
    FROM public.organizations WHERE id = _org;
  IF NOT COALESCE(_telemetry_on, true) THEN
    RAISE EXCEPTION 'telemetry_disabled';
  END IF;

  SELECT id INTO _sid FROM public.subjects
  WHERE organization_id = _org AND external_id = _subject;
  SELECT id INTO _pid FROM public.permissions
  WHERE organization_id = _org AND scope = 'customer' AND slug = _perm;

  IF _allowed IS NULL THEN
    _resolved := public.has_permission_for_external(_org, _subject, _perm, _ctx);
  ELSE
    _resolved := _allowed;
  END IF;
  IF _resolved THEN
    SELECT public._granting_role_slugs(_org, _subject, _perm, _ctx) INTO _roles;
  ELSE
    _roles := '{}';
  END IF;
  IF _subject_mode = 'hashed' THEN
    _store_as := encode(digest(_subject, 'sha256'), 'hex');
  ELSE
    _store_as := _subject;
  END IF;

  INSERT INTO public.check_events (
    organization_id, subject_id, subject_external_id,
    permission_id, permission_slug, matched_role_slugs,
    allowed, api_key_id, event_type, context
  ) VALUES (
    _org, _sid, _store_as,
    _pid, _perm, COALESCE(_roles, '{}'),
    _resolved, _key, 'custom', _ctx
  ) RETURNING id INTO _id;
  RETURN _id;
END;
$$;
