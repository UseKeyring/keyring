-- 0034 OUTBOUND WEBHOOKS + SUBJECT ACCESS SNAPSHOT
--
-- Lets any org mirror Keyring access into their own Supabase / Neon Postgres
-- so RLS can check `keyring.has('teacher')` / `keyring.can('invoices.refund')`
-- locally with zero per-row network calls.
--
-- Design (per confirmed decisions):
--   - Single-org per customer DB: mirror tables carry NO organization_id;
--     the org is implicit from the endpoint URL + snapshot key.
--   - Expiry: rows are LEFT in the mirror and FILTERED at read time
--     (helpers check expires_at > now()). No hard-delete on expiry.
--   - Event base expanded as far as the graph goes: grants, subjects, roles,
--     permissions, and role<->permission mappings (13 event types + wildcards).
--
-- What this migration builds:
--   - webhook_endpoints: per-org outbound subscriptions (url, HMAC secret,
--     events[], active). Secret stored server-side; RLS-gated to org managers.
--   - webhook_outbox: per-endpoint delivery queue (pending/sending/delivered/
--     failed + attempts/next_retry_at). Written by triggers, drained by the
--     `webhook-dispatch` edge function (service_role, documented exception
--     like polar-webhook). Never written by browser clients.
--   - Triggers on grants/subjects/roles/permissions/role_permissions enqueue
--     one outbox row per matching active endpoint.
--   - api_get_subject_access(_hash, _subject): snapshot for backfill/reconcile
--     (GET /api/v1/subjects/:id/access). Scope `check` — no new scope needed
--     for reads.
--   - api_create/list/delete_webhook_endpoint: endpoint CRUD over the
--     publishable-key client. New scopes `webhooks.read` + `webhooks.write`
--     (secret keys only; publishable capped to `check` as before).
--
-- Apply in the Supabase SQL editor (idempotent).

-- ── Scopes: allow webhooks.read / webhooks.write on secret keys ─────────────
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
    'telemetry.write',
    'webhooks.read',
    'webhooks.write'
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

-- Least-privilege upgrade: secret keys that could already manage grants gain
-- webhook management too (same operator persona). Keys without grants.write
-- gain nothing.
UPDATE public.api_keys
SET scopes = array(SELECT DISTINCT unnest(scopes || ARRAY['webhooks.read', 'webhooks.write']) ORDER BY 1)
WHERE key_type = 'secret'
  AND 'grants.write' = ANY (scopes)
  AND NOT ('webhooks.write' = ANY (scopes));

-- ── webhook_endpoints ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL CHECK (url LIKE 'https://%'),
  -- HMAC-SHA256 signing secret. Needed in plaintext to sign outbound
  -- deliveries; RLS-gated to org managers (see policies below). Rotate by
  -- updating the row; deliveries in flight keep their recorded signature.
  secret text NOT NULL,
  -- Subscribed events. Supports exact names (grant.created), prefixes
  -- (grant.*), and full wildcard (*). Empty array = all events.
  -- Catalog: grant.created/updated/deleted, subject.created/updated/deleted,
  -- role.created/updated/deleted, permission.created/updated/deleted,
  -- role.permissions_updated.
  events text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  failure_count integer NOT NULL DEFAULT 0,
  last_triggered_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_org_idx
  ON public.webhook_endpoints (organization_id) WHERE active;

ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org read webhooks" ON public.webhook_endpoints;
CREATE POLICY "org read webhooks" ON public.webhook_endpoints FOR SELECT TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.read')
      OR public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.read')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );
DROP POLICY IF EXISTS "org manage webhooks" ON public.webhook_endpoints;
CREATE POLICY "org manage webhooks" ON public.webhook_endpoints FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );
DROP POLICY IF EXISTS "org update webhooks" ON public.webhook_endpoints;
CREATE POLICY "org update webhooks" ON public.webhook_endpoints FOR UPDATE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );
DROP POLICY IF EXISTS "org delete webhooks" ON public.webhook_endpoints;
CREATE POLICY "org delete webhooks" ON public.webhook_endpoints FOR DELETE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );

-- ── webhook_outbox (per-endpoint delivery queue) ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.webhook_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES public.webhook_endpoints(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_outbox_drain_idx
  ON public.webhook_outbox (status, next_retry_at, created_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS webhook_outbox_org_idx
  ON public.webhook_outbox (organization_id, created_at DESC);

ALTER TABLE public.webhook_outbox ENABLE ROW LEVEL SECURITY;

-- Managers can observe the queue; only the dispatcher (service_role) writes.
DROP POLICY IF EXISTS "org read outbox" ON public.webhook_outbox;
CREATE POLICY "org read outbox" ON public.webhook_outbox FOR SELECT TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.read')
      OR public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'roles.read')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );

-- ── Event matching helper ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.webhook_event_matches(_subscribed text[], _event text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT _subscribed IS NULL
    OR cardinality(_subscribed) = 0
    OR '*' = ANY (_subscribed)
    OR _event = ANY (_subscribed)
    OR (split_part(_event, '.', 1) || '.*') = ANY (_subscribed);
$$;

-- ── Enqueue fan-out (one outbox row per matching active endpoint) ─────────────
CREATE OR REPLACE FUNCTION public.enqueue_webhook_event(_org uuid, _event text, _payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  INSERT INTO public.webhook_outbox (organization_id, endpoint_id, event, payload)
  SELECT _org, e.id, _event, COALESCE(_payload, '{}'::jsonb)
  FROM public.webhook_endpoints e
  WHERE e.organization_id = _org
    AND e.active
    AND public.webhook_event_matches(e.events, _event);
  UPDATE public.webhook_endpoints
  SET last_triggered_at = now()
  WHERE organization_id = _org
    AND active
    AND public.webhook_event_matches(events, _event);
END;
$$;

-- ── Graph triggers → outbox ───────────────────────────────────────────────────
-- Payloads carry everything the customer applier needs for an upsert/delete
-- on keyring.access WITHOUT a follow-up fetch (single-org mirror: no org_id
-- column needed downstream; org arrives in the delivery envelope).

CREATE OR REPLACE FUNCTION public.trg_grants_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _event text;
  _payload jsonb;
  _role_slug text;
  _subject_ext text;
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
  _payload := jsonb_build_object(
    'subject', _subject_ext,
    'role', _role_slug,
    'expires_at', COALESCE(NEW.expires_at, OLD.expires_at),
    'grant_id', COALESCE(NEW.id, OLD.id)
  );
  PERFORM public.enqueue_webhook_event(COALESCE(NEW.organization_id, OLD.organization_id), _event, _payload);
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS trg_webhook_grants ON public.grants;
CREATE TRIGGER trg_webhook_grants
  AFTER INSERT OR UPDATE OR DELETE ON public.grants
  FOR EACH ROW EXECUTE FUNCTION public.trg_grants_webhook();

CREATE OR REPLACE FUNCTION public.trg_subjects_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _event text;
BEGIN
  IF TG_OP = 'INSERT' THEN _event := 'subject.created';
  ELSIF TG_OP = 'DELETE' THEN _event := 'subject.deleted';
  ELSE _event := 'subject.updated';
  END IF;
  PERFORM public.enqueue_webhook_event(
    COALESCE(NEW.organization_id, OLD.organization_id), _event,
    jsonb_build_object(
      'subject', COALESCE(NEW.external_id, OLD.external_id),
      'display_name', COALESCE(NEW.display_name, OLD.display_name)
    )
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS trg_webhook_subjects ON public.subjects;
CREATE TRIGGER trg_webhook_subjects
  AFTER INSERT OR UPDATE OR DELETE ON public.subjects
  FOR EACH ROW EXECUTE FUNCTION public.trg_subjects_webhook();

CREATE OR REPLACE FUNCTION public.trg_roles_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _event text;
BEGIN
  IF TG_OP = 'INSERT' THEN _event := 'role.created';
  ELSIF TG_OP = 'DELETE' THEN _event := 'role.deleted';
  ELSE _event := 'role.updated';
  END IF;
  -- Customer-plane only: console roles never leave the workspace.
  IF COALESCE(NEW.scope, OLD.scope) <> 'customer' THEN RETURN COALESCE(NEW, OLD); END IF;
  PERFORM public.enqueue_webhook_event(
    COALESCE(NEW.organization_id, OLD.organization_id), _event,
    jsonb_build_object(
      'role', COALESCE(NEW.slug, OLD.slug),
      'name', COALESCE(NEW.name, OLD.name)
    )
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS trg_webhook_roles ON public.roles;
CREATE TRIGGER trg_webhook_roles
  AFTER INSERT OR UPDATE OR DELETE ON public.roles
  FOR EACH ROW EXECUTE FUNCTION public.trg_roles_webhook();

CREATE OR REPLACE FUNCTION public.trg_permissions_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _event text;
BEGIN
  IF TG_OP = 'INSERT' THEN _event := 'permission.created';
  ELSIF TG_OP = 'DELETE' THEN _event := 'permission.deleted';
  ELSE _event := 'permission.updated';
  END IF;
  IF COALESCE(NEW.scope, OLD.scope) <> 'customer' THEN RETURN COALESCE(NEW, OLD); END IF;
  PERFORM public.enqueue_webhook_event(
    COALESCE(NEW.organization_id, OLD.organization_id), _event,
    jsonb_build_object(
      'permission', COALESCE(NEW.slug, OLD.slug),
      'name', COALESCE(NEW.name, OLD.name),
      'category', COALESCE(NEW.category, OLD.category)
    )
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS trg_webhook_permissions ON public.permissions;
CREATE TRIGGER trg_webhook_permissions
  AFTER INSERT OR UPDATE OR DELETE ON public.permissions
  FOR EACH ROW EXECUTE FUNCTION public.trg_permissions_webhook();

CREATE OR REPLACE FUNCTION public.trg_role_permissions_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _role_slug text;
  _perm_slug text;
BEGIN
  SELECT slug INTO _role_slug FROM public.roles WHERE id = COALESCE(NEW.role_id, OLD.role_id);
  SELECT slug INTO _perm_slug FROM public.permissions WHERE id = COALESCE(NEW.permission_id, OLD.permission_id);
  PERFORM public.enqueue_webhook_event(
    COALESCE(NEW.organization_id, OLD.organization_id),
    'role.permissions_updated',
    jsonb_build_object('role', _role_slug, 'permission', _perm_slug, 'op', TG_OP)
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS trg_webhook_role_permissions ON public.role_permissions;
CREATE TRIGGER trg_webhook_role_permissions
  AFTER INSERT OR DELETE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.trg_role_permissions_webhook();

-- ── Snapshot RPC: full access for one subject (backfill / nightly reconcile) ──
-- Scope `check`: any key that can check can snapshot. Expired grants are
-- EXCLUDED here (mirror filters them at read time too; rows stay, filtered).
CREATE OR REPLACE FUNCTION public.api_get_subject_access(_hash text, _subject text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _sid uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'check') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO _sid FROM public.subjects
  WHERE organization_id = _org AND external_id = _subject;
  IF _sid IS NULL THEN
    RETURN json_build_object('subject', _subject, 'roles', '[]'::json, 'permissions', '[]'::json);
  END IF;
  RETURN json_build_object(
    'subject', _subject,
    'roles', COALESCE((
      SELECT json_agg(r.slug ORDER BY r.slug)
      FROM public.grants g JOIN public.roles r ON r.id = g.role_id
      WHERE g.organization_id = _org AND g.subject_id = _sid
        AND r.scope = 'customer'
        AND (g.expires_at IS NULL OR g.expires_at > now())
    ), '[]'::json),
    'permissions', COALESCE((
      SELECT json_agg(DISTINCT p.slug ORDER BY p.slug)
      FROM public.grants g
      JOIN public.role_permissions rp ON rp.role_id = g.role_id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE g.organization_id = _org AND g.subject_id = _sid
        AND p.scope = 'customer'
        AND (g.expires_at IS NULL OR g.expires_at > now())
    ), '[]'::json)
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.api_get_subject_access(text, text) TO anon, authenticated, service_role;

-- ── Endpoint CRUD RPCs (key-authed, org-scoped) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.api_create_webhook_endpoint(
  _hash text, _name text, _url text, _secret text, _events text[] DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'webhooks.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _name IS NULL OR btrim(_name) = '' THEN RAISE EXCEPTION 'invalid_name:name required'; END IF;
  IF _url IS NULL OR _url NOT LIKE 'https://%' THEN RAISE EXCEPTION 'invalid_url:want https://…'; END IF;
  IF _secret IS NULL OR length(_secret) < 16 THEN RAISE EXCEPTION 'invalid_secret:min 16 chars'; END IF;
  INSERT INTO public.webhook_endpoints (organization_id, name, url, secret, events)
  VALUES (_org, btrim(_name), btrim(_url), _secret, COALESCE(_events, '{}'))
  RETURNING id, name, url, events, active, created_at INTO _row;
  RETURN json_build_object(
    'id', _row.id, 'name', _row.name, 'url', _row.url,
    'events', _row.events, 'active', _row.active, 'created_at', _row.created_at
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.api_create_webhook_endpoint(text, text, text, text, text[]) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.api_list_webhook_endpoints(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'webhooks.read') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  RETURN COALESCE((
    SELECT json_agg(json_build_object(
      'id', id, 'name', name, 'url', url, 'events', events,
      'active', active, 'failure_count', failure_count,
      'last_triggered_at', last_triggered_at, 'created_at', created_at
    ) ORDER BY created_at)
    FROM public.webhook_endpoints WHERE organization_id = _org
  ), '[]'::json);
END;
$$;
GRANT EXECUTE ON FUNCTION public.api_list_webhook_endpoints(text) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.api_delete_webhook_endpoint(_hash text, _id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'webhooks.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  DELETE FROM public.webhook_endpoints WHERE id = _id AND organization_id = _org;
  RETURN true;
END;
$$;
GRANT EXECUTE ON FUNCTION public.api_delete_webhook_endpoint(text, uuid) TO anon, authenticated, service_role;
