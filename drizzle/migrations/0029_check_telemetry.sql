-- 0029 CHECK TELEMETRY
--
-- Auto-logged permission evaluations + manual custom events powering the
-- telemetry dashboard (most used actions/roles, most active times).
-- Low-volume design: raw rows kept 90 days, aggregated client-side.
-- Apply in the Supabase SQL editor (idempotent).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Workspace telemetry preferences ─────────────────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS telemetry_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS telemetry_subject_mode text NOT NULL DEFAULT 'raw'
  CHECK (telemetry_subject_mode IN ('raw', 'hashed'));

-- ── Console permissions (global plane, org IS NULL like other console perms) ─
INSERT INTO public.permissions (slug, name, description, category, is_system, scope) VALUES
  ('telemetry.read', 'View telemetry', 'See usage analytics for checks and custom events.', 'Console', true, 'console'),
  ('telemetry.manage', 'Manage telemetry', 'Change telemetry collection and retention settings.', 'Console', true, 'console')
ON CONFLICT DO NOTHING;

-- Manager gets everything (all console perms); viewer gets every *read perm.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.slug = 'console-manager' AND r.scope = 'console'
  AND p.scope = 'console' AND p.slug IN ('telemetry.read', 'telemetry.manage')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.slug = 'console-viewer' AND r.scope = 'console'
  AND p.scope = 'console' AND p.slug = 'telemetry.read'
ON CONFLICT DO NOTHING;

-- ── Events table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.check_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  subject_id uuid REFERENCES public.subjects(id) ON DELETE SET NULL,
  subject_external_id text NOT NULL,
  permission_id uuid REFERENCES public.permissions(id) ON DELETE SET NULL,
  permission_slug text NOT NULL,
  matched_role_slugs text[] NOT NULL DEFAULT '{}',
  allowed boolean NOT NULL,
  api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  event_type text NOT NULL DEFAULT 'check' CHECK (event_type IN ('check', 'custom')),
  context jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS check_events_org_created_idx
  ON public.check_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS check_events_org_perm_idx
  ON public.check_events (organization_id, permission_slug);
CREATE INDEX IF NOT EXISTS check_events_org_subject_idx
  ON public.check_events (organization_id, subject_external_id);
CREATE INDEX IF NOT EXISTS check_events_org_roles_idx
  ON public.check_events USING gin (matched_role_slugs);

ALTER TABLE public.check_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org read check_events" ON public.check_events;
CREATE POLICY "org read check_events" ON public.check_events FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'telemetry.read')
      OR public.has_console_permission(auth.uid(), 'telemetry.manage')
    )
  );
-- Writes happen only inside SECURITY DEFINER functions (api_check /
-- api_track_event) so the publishable-key path (anon) can log without
-- direct insert rights. No insert/update/delete policies = client writes blocked.

-- ── API key scopes: allow telemetry scopes on secret keys ───────────────────
CREATE OR REPLACE FUNCTION public.guard_api_key_scopes()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  _allowed text[] := ARRAY[
    'check',
    'grants.write',
    'roles.read',
    'actions.read',
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

-- ── Internal helper: snapshot granting role slugs for a subject+permission ──
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
$$;

-- ── api_check now logs telemetry atomically ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.api_check(_hash text, _subject text, _perm text)
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
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'check') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;

  _allowed := public.has_permission_for_external(_org, _subject, _perm);

  -- Telemetry: best-effort, never break the check itself.
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
        SELECT public._granting_role_slugs(_org, _subject, _perm) INTO _roles;
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
        allowed, api_key_id, event_type
      ) VALUES (
        _org, _sid, _store_as,
        _pid, _perm, COALESCE(_roles, '{}'),
        _allowed, _key, 'check'
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Swallow telemetry failures (e.g. pgcrypto missing): check stays authoritative.
    NULL;
  END;

  RETURN _allowed;
END;
$$;

-- ── Manual events: POST /api/v1/events calls this ───────────────────────────
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
    _resolved := public.has_permission_for_external(_org, _subject, _perm);
  ELSE
    _resolved := _allowed;
  END IF;
  IF _resolved THEN
    SELECT public._granting_role_slugs(_org, _subject, _perm) INTO _roles;
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
    _resolved, _key, 'custom', COALESCE(_context, '{}')
  ) RETURNING id INTO _id;
  RETURN _id;
END;
$$;

-- ── Retention: raw rows kept 90 days ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_check_events(_org uuid, _days int DEFAULT 90)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _n int;
BEGIN
  -- Console caller must hold telemetry.manage in the ACTIVE workspace and the
  -- target must be that workspace (dashboard passes its own org id).
  IF _org IS DISTINCT FROM public.my_organization_id() THEN
    RAISE EXCEPTION 'cross_workspace_purge_forbidden';
  END IF;
  IF NOT public.has_console_permission(auth.uid(), 'telemetry.manage') THEN
    RAISE EXCEPTION 'telemetry_manage_required';
  END IF;
  DELETE FROM public.check_events
  WHERE organization_id = _org
    AND created_at < now() - (GREATEST(_days, 1) || ' days')::interval;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_check(text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.api_track_event(text, text, text, boolean, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_check_events(uuid, int) TO authenticated;
