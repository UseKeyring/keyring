-- ══════════════════════════════════════════════════════════════════════
-- KEYRING NATIVE POSTGRES SCHEMA (BYO database, no Supabase)
-- ══════════════════════════════════════════════════════════════════════
--
-- Everything lives in a dedicated `keyring` schema — `public` is untouched.
-- On Supabase this also means PostgREST/the linter ignore it unless you
-- explicitly expose the schema (Project Settings → API → Exposed schemas).
-- Two ways to call it:
--   a) Direct Postgres connection (server backend, scripts, psql):
--        SELECT keyring.api_check('<hash>', 'user_123', 'invoices.refund');
--   b) PostgREST RPC: expose `keyring`, then
--        POST /rest/v1/rpc/api_check  { _hash, _subject, _perm }
--      (supabase-js: supabase.schema('keyring').rpc('api_check', {...})).
--
-- Self-contained build of the Keyring Management API data plane for YOUR OWN
-- Postgres (14+): vanilla self-host or a fresh Supabase project used as a
-- plain Postgres. No Supabase Auth, no auth.users, no auth.uid(), no console
-- login — tables are RLS-locked (§9) and every operation goes through a
-- key-hash authed RPC. Run it on any empty database:
--
--   psql "$DATABASE_URL" -f drizzle/native.sql
--
-- Then bootstrap one workspace + root key (generate the raw key app-side so
-- the secret never travels; only the SHA-256 hex is stored):
--
--   export KR_KEY="kr_sk_live_$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-43)"
--   export KR_HASH=$(echo -n "$KR_KEY" | sha256sum | cut -d' ' -f1)
--   psql "$DATABASE_URL" -v slug=myapp -v name=MyApp -v hash="$KR_HASH" \
--     -v prefix="${KR_KEY:0:12}" -f - <<'SQL'
--   SELECT keyring.keyring_bootstrap('myapp', 'MyApp', :'hash', :'prefix');
--   SQL
--   echo "Root key: $KR_KEY"  # shown once — store it in a vault
--
-- From there the standard flow works key-first (same as hosted):
--   POST /permissions  ->  POST /roles { permissions }  ->  POST /grants
--   GET  /check?subject=...&permission=...
-- Every function below is key-hash authed and org-scoped, callable over
-- direct Postgres or PostgREST: SELECT keyring.api_check(...).
--
-- What is INCLUDED (runtime plane):
--   organizations, spaces, roles, permissions, role_permissions,
--   subjects (+attrs), grants (+expires_at, +condition ABAC),
--   api_keys, check_events (telemetry),
--   webhook_endpoints + webhook_outbox, all api_* RPCs, org-integrity
--   triggers, webhook fan-out triggers.
-- Scopes: platform level (no space) plus fully isolated per-space
-- roles/actions/grants. NULL space = platform scope; a slug = that space
-- only. Checks evaluate exactly the scope passed — no cross-scope
-- inheritance.
--
-- What is DELIBERATELY EXCLUDED (hosted console plane):
--   profiles, member_roles, organization_members, organization_join_requests,
--   subscription_plans, user_subscriptions, billing_*, waitlist_emails,
--   supabase_integrations, supabase_link_sessions, backups, per-user console
--   RLS policies,
--   auth.users triggers, my_organization_id / has_console_permission helpers.
--   Multi-workspace still works (organization_id on every row) — you just
--   create extra orgs/keys with keyring_bootstrap / keyring_issue_key.
--
-- This file is NOT part of the Supabase incremental chain in
-- drizzle/migrations/. Never apply it to a hosted project that already ran
-- 0000–0045. It is idempotent: safe to re-run.
--
-- Requires: pgcrypto (gen_random_uuid, digest for hashed telemetry mode).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS keyring;

-- ══════════════════════════════════════════════════════════════════════
-- §1 TABLES (runtime plane only)
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS keyring.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  avatar_url text,
  website text,
  support_email text,
  -- Native: plain nullable audit marker, NOT a FK to auth.users.
  created_by uuid,
  telemetry_enabled boolean NOT NULL DEFAULT true,
  telemetry_subject_mode text NOT NULL DEFAULT 'raw'
    CHECK (telemetry_subject_mode IN ('raw', 'hashed')),
  default_role_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_reserved_check CHECK (slug NOT IN ('account'))
);

CREATE TABLE IF NOT EXISTS keyring.spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES keyring.organizations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  default_role_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug),
  CONSTRAINT spaces_slug_format_check CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE TABLE IF NOT EXISTS keyring.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'customer' CHECK (scope IN ('customer', 'console')),
  organization_id uuid REFERENCES keyring.organizations(id) ON DELETE CASCADE,
  space_id uuid REFERENCES keyring.spaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_scope_org_check CHECK (
    (scope = 'console' AND organization_id IS NULL)
    OR (scope = 'customer' AND organization_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_slug_global_uniq
  ON keyring.roles (slug) WHERE organization_id IS NULL;
DROP INDEX IF EXISTS keyring.roles_slug_org_uniq;
DROP INDEX IF EXISTS roles_slug_org_uniq;
-- Per-scope uniques are created after the upgrade block below (they need
-- space_id, which older installs only gain there).
CREATE INDEX IF NOT EXISTS roles_organization_id_idx ON keyring.roles (organization_id);

CREATE TABLE IF NOT EXISTS keyring.permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'general',
  is_system boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'customer' CHECK (scope IN ('customer', 'console')),
  organization_id uuid REFERENCES keyring.organizations(id) ON DELETE CASCADE,
  space_id uuid REFERENCES keyring.spaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permissions_scope_org_check CHECK (
    (scope = 'console' AND organization_id IS NULL)
    OR (scope = 'customer' AND organization_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS permissions_slug_global_uniq
  ON keyring.permissions (slug) WHERE organization_id IS NULL;
DROP INDEX IF EXISTS keyring.permissions_slug_org_uniq;
DROP INDEX IF EXISTS permissions_slug_org_uniq;
-- Per-scope uniques are created after the upgrade block below (they need
-- space_id, which older installs only gain there).
CREATE INDEX IF NOT EXISTS permissions_organization_id_idx ON keyring.permissions (organization_id);

CREATE TABLE IF NOT EXISTS keyring.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES keyring.roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES keyring.permissions(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES keyring.organizations(id) ON DELETE CASCADE,
  space_id uuid REFERENCES keyring.spaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, permission_id)
);
CREATE INDEX IF NOT EXISTS role_permissions_organization_id_idx ON keyring.role_permissions (organization_id);

CREATE TABLE IF NOT EXISTS keyring.subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL,
  display_name text,
  attrs jsonb NOT NULL DEFAULT '{}',
  organization_id uuid NOT NULL REFERENCES keyring.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subjects_external_org_uniq
  ON keyring.subjects (organization_id, external_id);
CREATE INDEX IF NOT EXISTS subjects_organization_id_idx ON keyring.subjects (organization_id);
CREATE INDEX IF NOT EXISTS subjects_attrs_gin_idx ON keyring.subjects USING gin (attrs);

CREATE TABLE IF NOT EXISTS keyring.grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES keyring.roles(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES keyring.subjects(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES keyring.organizations(id) ON DELETE CASCADE,
  space_id uuid REFERENCES keyring.spaces(id) ON DELETE CASCADE,
  expires_at timestamptz,
  condition jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One platform grant + one grant per space per (role, subject).
-- (Partial indexes live after the upgrade block below: older installs only
-- gain space_id there, and the indexes require the column to exist.)
CREATE INDEX IF NOT EXISTS grants_organization_id_idx ON keyring.grants (organization_id);
CREATE INDEX IF NOT EXISTS grants_subject_id_idx ON keyring.grants (subject_id);
CREATE INDEX IF NOT EXISTS grants_expires_at_idx
  ON keyring.grants (organization_id, expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS grants_condition_gin_idx ON keyring.grants USING gin (condition);

CREATE TABLE IF NOT EXISTS keyring.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  key_type text NOT NULL DEFAULT 'secret'
    CHECK (key_type IN ('secret', 'publishable')),
  scopes text[] NOT NULL DEFAULT '{}',
  organization_id uuid REFERENCES keyring.organizations(id) ON DELETE CASCADE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_organization_id_idx ON keyring.api_keys (organization_id);

CREATE TABLE IF NOT EXISTS keyring.check_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES keyring.organizations(id) ON DELETE CASCADE,
  space_id uuid REFERENCES keyring.spaces(id) ON DELETE SET NULL,
  subject_id uuid REFERENCES keyring.subjects(id) ON DELETE SET NULL,
  subject_external_id text NOT NULL,
  permission_id uuid REFERENCES keyring.permissions(id) ON DELETE SET NULL,
  permission_slug text NOT NULL,
  matched_role_slugs text[] NOT NULL DEFAULT '{}',
  allowed boolean NOT NULL,
  api_key_id uuid REFERENCES keyring.api_keys(id) ON DELETE SET NULL,
  event_type text NOT NULL DEFAULT 'check' CHECK (event_type IN ('check', 'custom')),
  context jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS check_events_api_key_id_idx ON keyring.check_events (api_key_id);
CREATE INDEX IF NOT EXISTS check_events_permission_id_idx ON keyring.check_events (permission_id);
CREATE INDEX IF NOT EXISTS check_events_subject_id_idx ON keyring.check_events (subject_id);
-- check_events_space_idx is created after the upgrade block below (it needs
-- space_id, which older installs only gain there).
CREATE INDEX IF NOT EXISTS check_events_org_created_idx
  ON keyring.check_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS check_events_org_perm_idx
  ON keyring.check_events (organization_id, permission_slug);
CREATE INDEX IF NOT EXISTS check_events_org_subject_idx
  ON keyring.check_events (organization_id, subject_external_id);
CREATE INDEX IF NOT EXISTS check_events_org_roles_idx
  ON keyring.check_events USING gin (matched_role_slugs);

CREATE TABLE IF NOT EXISTS keyring.webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES keyring.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL CHECK (url LIKE 'https://%'),
  secret text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  failure_count integer NOT NULL DEFAULT 0,
  last_triggered_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_org_idx
  ON keyring.webhook_endpoints (organization_id) WHERE active;

CREATE TABLE IF NOT EXISTS keyring.webhook_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES keyring.organizations(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES keyring.webhook_endpoints(id) ON DELETE CASCADE,
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
  ON keyring.webhook_outbox (status, next_retry_at, created_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS webhook_outbox_org_idx
  ON keyring.webhook_outbox (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS role_permissions_permission_id_idx
  ON keyring.role_permissions (permission_id);
CREATE INDEX IF NOT EXISTS webhook_outbox_endpoint_id_idx
  ON keyring.webhook_outbox (endpoint_id);
CREATE INDEX IF NOT EXISTS organizations_default_role_idx
  ON keyring.organizations (default_role_id);

-- Upgrade path: databases created by the pre-spaces native.sql gain the new
-- columns (fresh installs already have them from the CREATE TABLEs above).
ALTER TABLE keyring.roles ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES keyring.spaces(id) ON DELETE CASCADE;
ALTER TABLE keyring.permissions ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES keyring.spaces(id) ON DELETE CASCADE;
ALTER TABLE keyring.role_permissions ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES keyring.spaces(id) ON DELETE CASCADE;
ALTER TABLE keyring.grants ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES keyring.spaces(id) ON DELETE CASCADE;
ALTER TABLE keyring.check_events ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES keyring.spaces(id) ON DELETE SET NULL;
-- Pre-spaces installs carry the plain (role, subject) unique: drop it in
-- favour of the per-scope partial indexes declared above.
ALTER TABLE keyring.grants DROP CONSTRAINT IF EXISTS grants_role_id_subject_id_key;
-- Uniqueness is now per scope: platform rows (space NULL) keep the old
-- (org, slug) rule; space rows are unique per space.
CREATE UNIQUE INDEX IF NOT EXISTS roles_platform_slug_uniq
  ON keyring.roles (organization_id, slug)
  WHERE organization_id IS NOT NULL AND space_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS roles_space_slug_uniq
  ON keyring.roles (space_id, slug) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS permissions_platform_slug_uniq
  ON keyring.permissions (organization_id, slug)
  WHERE organization_id IS NOT NULL AND space_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS permissions_space_slug_uniq
  ON keyring.permissions (space_id, slug) WHERE space_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS grants_platform_uniq
  ON keyring.grants (role_id, subject_id) WHERE space_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS grants_space_uniq
  ON keyring.grants (role_id, subject_id, space_id) WHERE space_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS check_events_space_idx
  ON keyring.check_events (organization_id, space_id);

-- default_role pointer guards need roles to exist first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_default_role_fk'
  ) THEN
    ALTER TABLE keyring.organizations
      ADD CONSTRAINT organizations_default_role_fk
      FOREIGN KEY (default_role_id) REFERENCES keyring.roles(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'spaces_default_role_fk'
  ) THEN
    ALTER TABLE keyring.spaces
      ADD CONSTRAINT spaces_default_role_fk
      FOREIGN KEY (default_role_id) REFERENCES keyring.roles(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- §2 KEY AUTH + SCOPES (no auth.uid anywhere)
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION keyring._api_key_id(_hash text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _id uuid;
BEGIN
  UPDATE keyring.api_keys SET last_used_at = now()
  WHERE key_hash = _hash AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())
  RETURNING id INTO _id;
  RETURN _id;
END $$;

CREATE OR REPLACE FUNCTION keyring.api_key_has_scope(_id uuid, _scope text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = keyring AS $$
  SELECT EXISTS (SELECT 1 FROM keyring.api_keys WHERE id = _id AND _scope = ANY (scopes));
$$;

CREATE OR REPLACE FUNCTION keyring.guard_api_key_scopes()
RETURNS trigger LANGUAGE plpgsql SET search_path = keyring AS $$
DECLARE
  _allowed text[] := ARRAY[
    'check','grants.write','roles.read','roles.write','spaces.read','spaces.write',
    'actions.read','actions.write','subject_tokens.write','telemetry.read','telemetry.write',
    'webhooks.read','webhooks.write','integrations.write'
  ];
  _pub text[] := ARRAY['check'];
  _s text;
BEGIN
  IF NEW.scopes IS NULL THEN NEW.scopes := '{}'; END IF;
  FOREACH _s IN ARRAY NEW.scopes LOOP
    IF NOT (_s = ANY (_allowed)) THEN RAISE EXCEPTION 'invalid_api_key_scope:%', _s; END IF;
  END LOOP;
  IF NEW.key_type = 'publishable' THEN
    FOREACH _s IN ARRAY NEW.scopes LOOP
      IF NOT (_s = ANY (_pub)) THEN RAISE EXCEPTION 'publishable_scope_forbidden:%', _s; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_api_key_scopes ON keyring.api_keys;
CREATE TRIGGER trg_guard_api_key_scopes
  BEFORE INSERT OR UPDATE OF scopes, key_type ON keyring.api_keys
  FOR EACH ROW EXECUTE FUNCTION keyring.guard_api_key_scopes();

-- Least-privilege upgrade for pre-spaces keys: secret keys that could already
-- manage grants gain space management too (same operator persona).
UPDATE keyring.api_keys
SET scopes = array(SELECT DISTINCT unnest(scopes || ARRAY['spaces.read', 'spaces.write']) ORDER BY 1)
WHERE key_type = 'secret'
  AND 'grants.write' = ANY (scopes)
  AND NOT ('spaces.write' = ANY (scopes));

CREATE OR REPLACE FUNCTION keyring.api_key_meta(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _id uuid; _row record;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _id;
  IF _id IS NULL THEN RETURN NULL; END IF;
  SELECT name, organization_id, key_type, scopes, expires_at INTO _row
  FROM keyring.api_keys WHERE id = _id;
  RETURN json_build_object('name', _row.name, 'organization_id', _row.organization_id,
    'key_type', _row.key_type, 'scopes', COALESCE(to_json(_row.scopes), '[]'::json),
    'expires_at', _row.expires_at);
END $$;

CREATE OR REPLACE FUNCTION keyring.api_whoami(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _id uuid; _row record;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _id;
  IF _id IS NULL THEN RETURN NULL; END IF;
  SELECT name, organization_id, key_type, scopes, expires_at INTO _row
  FROM keyring.api_keys WHERE id = _id;
  RETURN json_build_object('name', _row.name, 'organization_id', _row.organization_id,
    'key_type', _row.key_type, 'scopes', COALESCE(to_json(_row.scopes), '[]'::json),
    'expires_at', _row.expires_at);
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- §3 ABAC CONDITION ENGINE (evaluated in Postgres)
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION keyring._abac_lookup(
  _key text, _subject_attrs jsonb, _context jsonb, _from text DEFAULT 'either'
) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = keyring AS $$
  SELECT CASE
    WHEN _from = 'subject' THEN (_subject_attrs -> _key)
    WHEN _from = 'context' THEN (_context -> _key)
    ELSE COALESCE((_context -> _key), (_subject_attrs -> _key))
  END
$$;

CREATE OR REPLACE FUNCTION keyring._abac_clause_matches(
  _clause jsonb, _subject_attrs jsonb, _context jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = keyring AS $$
DECLARE _attr text; _from text; _actual jsonb; _expected jsonb;
  _num double precision; _op text; _list jsonb; _item jsonb;
BEGIN
  IF _clause IS NULL OR _clause = '{}'::jsonb THEN RETURN true; END IF;
  IF _clause ? 'all' THEN
    FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_clause -> 'all', '[]'::jsonb)) LOOP
      IF NOT keyring._abac_condition_matches(_item, _subject_attrs, _context) THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  END IF;
  IF _clause ? 'any' THEN
    FOR _item IN SELECT * FROM jsonb_array_elements(COALESCE(_clause -> 'any', '[]'::jsonb)) LOOP
      IF keyring._abac_condition_matches(_item, _subject_attrs, _context) THEN RETURN true; END IF;
    END LOOP;
    RETURN false;
  END IF;
  IF _clause ? 'not' THEN
    RETURN NOT keyring._abac_condition_matches(_clause -> 'not', _subject_attrs, _context);
  END IF;
  _attr := _clause ->> 'attr';
  IF _attr IS NULL OR btrim(_attr) = '' THEN RETURN false; END IF;
  _from := COALESCE(NULLIF(_clause ->> 'from', ''), 'either');
  IF _from NOT IN ('either', 'subject', 'context') THEN RAISE EXCEPTION 'invalid_condition_from:%', _from; END IF;
  _actual := keyring._abac_lookup(_attr, COALESCE(_subject_attrs, '{}'), COALESCE(_context, '{}'), _from);
  IF _clause ? 'exists' THEN
    IF (_clause ->> 'exists')::boolean IS TRUE THEN RETURN _actual IS NOT NULL;
    ELSE RETURN _actual IS NULL; END IF;
  END IF;
  IF _actual IS NULL THEN RETURN false; END IF;
  IF _clause ? 'equals' THEN RETURN _actual = (_clause -> 'equals'); END IF;
  IF _clause ? 'in' THEN
    _list := _clause -> 'in';
    IF jsonb_typeof(_list) <> 'array' THEN RAISE EXCEPTION 'invalid_condition_in (want array)'; END IF;
    FOR _item IN SELECT * FROM jsonb_array_elements(_list) LOOP
      IF _actual = _item THEN RETURN true; END IF;
    END LOOP;
    RETURN false;
  END IF;
  FOR _op IN SELECT unnest(ARRAY['gt','gte','lt','lte']) LOOP
    IF _clause ? _op THEN
      BEGIN _num := (_actual #>> '{}')::double precision; _expected := _clause -> _op;
      EXCEPTION WHEN OTHERS THEN RETURN false; END;
      IF jsonb_typeof(_expected) <> 'number' THEN RAISE EXCEPTION 'invalid_condition_% (want number)', _op; END IF;
      CASE _op
        WHEN 'gt' THEN RETURN _num > (_expected::text)::double precision;
        WHEN 'gte' THEN RETURN _num >= (_expected::text)::double precision;
        WHEN 'lt' THEN RETURN _num < (_expected::text)::double precision;
        WHEN 'lte' THEN RETURN _num <= (_expected::text)::double precision;
      END CASE;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'invalid_condition:% (want all|any|not|equals|in|gt|gte|lt|lte|exists)', _clause;
END $$;

CREATE OR REPLACE FUNCTION keyring._abac_condition_matches(
  _condition jsonb, _subject_attrs jsonb, _context jsonb
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = keyring AS $$
  SELECT CASE WHEN _condition IS NULL OR _condition = '{}'::jsonb THEN true
    ELSE keyring._abac_clause_matches(_condition, COALESCE(_subject_attrs, '{}'), COALESCE(_context, '{}')) END
$$;

-- ══════════════════════════════════════════════════════════════════════
-- §4 CORE CHECKS (org-scoped, expiry- and ABAC-aware)
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION keyring.ensure_subject(
  _organization_id uuid, _external_id text,
  _display_name text DEFAULT NULL, _attrs jsonb DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _id uuid;
BEGIN
  IF _organization_id IS NULL THEN RAISE EXCEPTION 'Organization is required'; END IF;
  INSERT INTO keyring.subjects (organization_id, external_id, display_name, attrs)
  VALUES (_organization_id, _external_id, NULLIF(_display_name, ''), COALESCE(_attrs, '{}'))
  ON CONFLICT (organization_id, external_id) DO UPDATE SET
    display_name = COALESCE(EXCLUDED.display_name, keyring.subjects.display_name),
    attrs = CASE WHEN EXCLUDED.attrs IS NULL OR EXCLUDED.attrs = '{}'::jsonb
      THEN keyring.subjects.attrs ELSE keyring.subjects.attrs || EXCLUDED.attrs END
  RETURNING id INTO _id;
  RETURN _id;
END $$;

CREATE OR REPLACE FUNCTION keyring.has_role(_subject_id uuid, _slug text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = keyring AS $$
  SELECT EXISTS (SELECT 1 FROM keyring.grants g JOIN keyring.roles r ON r.id = g.role_id
    WHERE g.subject_id = _subject_id AND r.slug = _slug
      AND (g.expires_at IS NULL OR g.expires_at > now()));
$$;

CREATE OR REPLACE FUNCTION keyring.has_permission(_subject_id uuid, _perm text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = keyring AS $$
  SELECT EXISTS (SELECT 1 FROM keyring.grants g
    JOIN keyring.role_permissions rp ON rp.role_id = g.role_id
    JOIN keyring.permissions p ON p.id = rp.permission_id
    WHERE g.subject_id = _subject_id AND p.slug = _perm
      AND (g.expires_at IS NULL OR g.expires_at > now()));
$$;

-- Scope resolver (NULL/blank = platform scope).
CREATE OR REPLACE FUNCTION keyring._resolve_space_id(_org uuid, _space text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _id uuid;
BEGIN
  IF _space IS NULL OR btrim(_space) = '' THEN RETURN NULL; END IF;
  SELECT id INTO _id FROM keyring.spaces
  WHERE organization_id = _org AND slug = lower(btrim(_space));
  IF _id IS NULL THEN RAISE EXCEPTION 'unknown_space:%', btrim(_space); END IF;
  RETURN _id;
END $$;

DROP FUNCTION IF EXISTS keyring.has_permission_for_external(uuid, text, text, jsonb);
CREATE OR REPLACE FUNCTION keyring.has_permission_for_external(
  _organization_id uuid, _subject_id text, _perm text,
  _context jsonb DEFAULT '{}', _space text DEFAULT NULL
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = keyring AS $$
  SELECT EXISTS (SELECT 1 FROM keyring.grants g
    JOIN keyring.roles r ON r.id = g.role_id
    JOIN keyring.role_permissions rp ON rp.role_id = g.role_id
    JOIN keyring.permissions p ON p.id = rp.permission_id
    JOIN keyring.subjects s ON s.id = g.subject_id
    WHERE g.organization_id = _organization_id AND r.organization_id = _organization_id
      AND s.organization_id = _organization_id AND p.organization_id = _organization_id
      AND r.scope = 'customer' AND s.external_id = _subject_id AND p.slug = _perm
      AND g.space_id IS NOT DISTINCT FROM keyring._resolve_space_id(_organization_id, _space)
      AND r.space_id IS NOT DISTINCT FROM g.space_id
      AND p.space_id IS NOT DISTINCT FROM g.space_id
      AND (g.expires_at IS NULL OR g.expires_at > now())
      AND keyring._abac_condition_matches(g.condition, s.attrs, COALESCE(_context, '{}')));
$$;

DROP FUNCTION IF EXISTS keyring._granting_role_slugs(uuid, text, text, jsonb);
CREATE OR REPLACE FUNCTION keyring._granting_role_slugs(
  _org uuid, _subject text, _perm text, _context jsonb DEFAULT '{}', _space text DEFAULT NULL
) RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = keyring AS $$
  SELECT COALESCE(array_agg(DISTINCT r.slug), '{}') FROM keyring.grants g
  JOIN keyring.roles r ON r.id = g.role_id
  JOIN keyring.role_permissions rp ON rp.role_id = g.role_id
  JOIN keyring.permissions p ON p.id = rp.permission_id
  JOIN keyring.subjects s ON s.id = g.subject_id
  WHERE g.organization_id = _org AND r.organization_id = _org
    AND s.organization_id = _org AND p.organization_id = _org
    AND r.scope = 'customer' AND s.external_id = _subject AND p.slug = _perm
    AND (g.expires_at IS NULL OR g.expires_at > now())
    AND keyring._abac_condition_matches(g.condition, s.attrs, COALESCE(_context, '{}'));
$$;

-- ══════════════════════════════════════════════════════════════════════
-- §5 MANAGEMENT RPCs (key-hash authed, org-scoped)
-- ══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS keyring.api_check(text, text, text, jsonb);
CREATE OR REPLACE FUNCTION keyring.api_check(
  _hash text, _subject text, _perm text, _context jsonb DEFAULT '{}', _space text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _allowed boolean; _sid uuid; _pid uuid; _space_id uuid;
  _roles text[]; _store_as text; _telemetry_on boolean; _subject_mode text; _ctx jsonb;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'check') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  _ctx := COALESCE(_context, '{}');
  IF jsonb_typeof(_ctx) <> 'object' THEN RAISE EXCEPTION 'invalid_context (want object)'; END IF;
  SELECT keyring._resolve_space_id(_org, _space) INTO _space_id;
  _allowed := keyring.has_permission_for_external(_org, _subject, _perm, _ctx, _space);
  BEGIN
    SELECT telemetry_enabled, telemetry_subject_mode INTO _telemetry_on, _subject_mode
    FROM keyring.organizations WHERE id = _org;
    IF COALESCE(_telemetry_on, true) THEN
      SELECT id INTO _sid FROM keyring.subjects WHERE organization_id = _org AND external_id = _subject;
      SELECT id INTO _pid FROM keyring.permissions WHERE organization_id = _org AND scope = 'customer' AND slug = _perm
        AND space_id IS NOT DISTINCT FROM _space_id;
      IF _allowed THEN SELECT keyring._granting_role_slugs(_org, _subject, _perm, _ctx, _space) INTO _roles;
      ELSE _roles := '{}'; END IF;
      IF _subject_mode = 'hashed' THEN _store_as := encode(digest(_subject, 'sha256'), 'hex');
      ELSE _store_as := _subject; END IF;
      INSERT INTO keyring.check_events (organization_id, space_id, subject_id, subject_external_id,
        permission_id, permission_slug, matched_role_slugs, allowed, api_key_id, event_type, context)
      VALUES (_org, _space_id, _sid, _store_as, _pid, _perm, COALESCE(_roles, '{}'), _allowed, _key, 'check', _ctx);
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL; END;
  RETURN _allowed;
END $$;

DROP FUNCTION IF EXISTS keyring.api_grant_role(text, text, text, text, timestamptz, int, jsonb);
CREATE OR REPLACE FUNCTION keyring.api_grant_role(
  _hash text, _role text, _subject text, _display_name text DEFAULT NULL,
  _expires_at timestamptz DEFAULT NULL, _ttl_seconds int DEFAULT NULL, _condition jsonb DEFAULT NULL,
  _space text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _rid uuid; _sid uuid; _space_id uuid; _exp timestamptz; _cond jsonb; _n int;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT keyring._resolve_space_id(_org, _space) INTO _space_id;
  SELECT id INTO _rid FROM keyring.roles WHERE slug = _role AND scope = 'customer' AND organization_id = _org
    AND space_id IS NOT DISTINCT FROM _space_id;
  IF _rid IS NULL THEN RAISE EXCEPTION 'unknown_role:%', _role; END IF;
  _cond := COALESCE(_condition, '{}');
  IF jsonb_typeof(_cond) <> 'object' THEN RAISE EXCEPTION 'invalid_condition (want object)'; END IF;
  PERFORM keyring._abac_condition_matches(_cond, '{}', '{}');
  IF _ttl_seconds IS NOT NULL THEN
    IF _ttl_seconds < 30 OR _ttl_seconds > 31536000 THEN
      RAISE EXCEPTION 'invalid_ttl_seconds:% (want 30..31536000)', _ttl_seconds; END IF;
    _exp := now() + (_ttl_seconds || ' seconds')::interval;
  ELSIF _expires_at IS NOT NULL THEN
    IF _expires_at <= now() THEN RAISE EXCEPTION 'expires_at_must_be_future'; END IF;
    IF _expires_at > now() + interval '366 days' THEN RAISE EXCEPTION 'expires_at_too_far (max 1 year)'; END IF;
    _exp := _expires_at;
  ELSE _exp := NULL; END IF;
  SELECT keyring.ensure_subject(_org, _subject, _display_name) INTO _sid;
  IF _space_id IS NULL THEN
    INSERT INTO keyring.grants (organization_id, role_id, subject_id, expires_at, condition)
    VALUES (_org, _rid, _sid, _exp, _cond)
    ON CONFLICT (role_id, subject_id) WHERE space_id IS NULL DO UPDATE
      SET expires_at = EXCLUDED.expires_at, condition = EXCLUDED.condition
      WHERE keyring.grants.expires_at IS DISTINCT FROM EXCLUDED.expires_at
         OR keyring.grants.condition IS DISTINCT FROM EXCLUDED.condition;
  ELSE
    INSERT INTO keyring.grants (organization_id, space_id, role_id, subject_id, expires_at, condition)
    VALUES (_org, _space_id, _rid, _sid, _exp, _cond)
    ON CONFLICT (role_id, subject_id, space_id) WHERE space_id IS NOT NULL DO UPDATE
      SET expires_at = EXCLUDED.expires_at, condition = EXCLUDED.condition
      WHERE keyring.grants.expires_at IS DISTINCT FROM EXCLUDED.expires_at
         OR keyring.grants.condition IS DISTINCT FROM EXCLUDED.condition;
  END IF;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END $$;

-- Single 8-arg function with DEFAULTs covers 3..8 arg callers; no wrapper
-- overloads (wrappers would make 4-arg calls ambiguous in plain SQL).

DROP FUNCTION IF EXISTS keyring.api_revoke_grant(text, text, text);
CREATE OR REPLACE FUNCTION keyring.api_revoke_grant(_hash text, _role text, _subject text, _space text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _rid uuid; _sid uuid; _space_id uuid;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT keyring._resolve_space_id(_org, _space) INTO _space_id;
  SELECT id INTO _rid FROM keyring.roles WHERE slug = _role AND scope = 'customer' AND organization_id = _org
    AND space_id IS NOT DISTINCT FROM _space_id;
  IF _rid IS NULL THEN RAISE EXCEPTION 'unknown_role:%', _role; END IF;
  SELECT id INTO _sid FROM keyring.subjects WHERE external_id = _subject AND organization_id = _org;
  IF _sid IS NULL THEN RETURN true; END IF;
  DELETE FROM keyring.grants WHERE role_id = _rid AND subject_id = _sid AND organization_id = _org
    AND space_id IS NOT DISTINCT FROM _space_id;
  RETURN true;
END $$;

DROP FUNCTION IF EXISTS keyring.api_list_roles(text);
CREATE OR REPLACE FUNCTION keyring.api_list_roles(_hash text, _space text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _space_id uuid;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'roles.read') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT keyring._resolve_space_id(_org, _space) INTO _space_id;
  RETURN COALESCE((SELECT json_agg(json_build_object('slug', r.slug, 'name', r.name,
    'description', r.description, 'space', s.slug, 'created_at', r.created_at) ORDER BY r.created_at)
    FROM keyring.roles r LEFT JOIN keyring.spaces s ON s.id = r.space_id
    WHERE r.scope = 'customer' AND r.organization_id = _org AND r.space_id IS NOT DISTINCT FROM _space_id), '[]'::json);
END $$;

DROP FUNCTION IF EXISTS keyring.api_list_permissions(text);
CREATE OR REPLACE FUNCTION keyring.api_list_permissions(_hash text, _space text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _space_id uuid;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'actions.read') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT keyring._resolve_space_id(_org, _space) INTO _space_id;
  RETURN COALESCE((SELECT json_agg(json_build_object('slug', p.slug, 'name', p.name,
    'description', p.description, 'category', p.category, 'space', s.slug, 'created_at', p.created_at) ORDER BY p.category)
    FROM keyring.permissions p LEFT JOIN keyring.spaces s ON s.id = p.space_id
    WHERE p.scope = 'customer' AND p.organization_id = _org AND p.space_id IS NOT DISTINCT FROM _space_id), '[]'::json);
END $$;

DROP FUNCTION IF EXISTS keyring.api_create_permission(text, text, text, text, text);
CREATE OR REPLACE FUNCTION keyring.api_create_permission(
  _hash text, _slug text, _name text, _category text DEFAULT NULL, _description text DEFAULT NULL,
  _space text DEFAULT NULL
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _space_id uuid; _row record;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'actions.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT keyring._resolve_space_id(_org, _space) INTO _space_id;
  IF _slug IS NULL OR btrim(_slug) = '' THEN RAISE EXCEPTION 'invalid_slug:slug required'; END IF;
  IF _slug <> lower(_slug) OR _slug !~ '^[a-z0-9]+[a-z0-9._-]*\.[a-z0-9._-]+$' THEN RAISE EXCEPTION 'invalid_slug:%', _slug; END IF;
  IF _name IS NULL OR btrim(_name) = '' THEN RAISE EXCEPTION 'invalid_name:name required'; END IF;
  IF _space_id IS NULL THEN
    INSERT INTO keyring.permissions (slug, name, category, description, scope, organization_id, space_id)
    VALUES (btrim(_slug), btrim(_name), COALESCE(NULLIF(btrim(COALESCE(_category, '')), ''), 'General'),
      NULLIF(btrim(COALESCE(_description, '')), ''), 'customer', _org, NULL)
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND space_id IS NULL DO UPDATE SET
      name = EXCLUDED.name, category = EXCLUDED.category, description = EXCLUDED.description
    RETURNING slug, name, description, category, created_at INTO _row;
  ELSE
    INSERT INTO keyring.permissions (slug, name, category, description, scope, organization_id, space_id)
    VALUES (btrim(_slug), btrim(_name), COALESCE(NULLIF(btrim(COALESCE(_category, '')), ''), 'General'),
      NULLIF(btrim(COALESCE(_description, '')), ''), 'customer', _org, _space_id)
    ON CONFLICT (space_id, slug) WHERE space_id IS NOT NULL DO UPDATE SET
      name = EXCLUDED.name, category = EXCLUDED.category, description = EXCLUDED.description
    RETURNING slug, name, description, category, created_at INTO _row;
  END IF;
  RETURN json_build_object('slug', _row.slug, 'name', _row.name,
    'description', _row.description, 'category', _row.category, 'space', _space, 'created_at', _row.created_at);
END $$;

DROP FUNCTION IF EXISTS keyring.api_create_role(text, text, text, text, text[]);
CREATE OR REPLACE FUNCTION keyring.api_create_role(
  _hash text, _slug text, _name text, _description text DEFAULT NULL, _permissions text[] DEFAULT NULL,
  _space text DEFAULT NULL
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _space_id uuid; _rid uuid; _row record; _slug_norm text; _perm text; _pid uuid;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'roles.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT keyring._resolve_space_id(_org, _space) INTO _space_id;
  IF _slug IS NULL OR btrim(_slug) = '' THEN RAISE EXCEPTION 'invalid_slug:slug required'; END IF;
  _slug_norm := lower(btrim(_slug));
  IF _slug_norm !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN RAISE EXCEPTION 'invalid_slug:%', _slug; END IF;
  IF _name IS NULL OR btrim(_name) = '' THEN RAISE EXCEPTION 'invalid_name:name required'; END IF;
  IF _permissions IS NOT NULL AND cardinality(_permissions) > 0 THEN
    FOREACH _perm IN ARRAY _permissions LOOP
      IF _perm IS NULL OR btrim(_perm) = '' THEN RAISE EXCEPTION 'unknown_permission:empty'; END IF;
      SELECT id INTO _pid FROM keyring.permissions
      WHERE slug = btrim(_perm) AND scope = 'customer' AND organization_id = _org
        AND space_id IS NOT DISTINCT FROM _space_id;
      IF _pid IS NULL THEN RAISE EXCEPTION 'unknown_permission:%', btrim(_perm); END IF;
    END LOOP;
  END IF;
  IF _space_id IS NULL THEN
    INSERT INTO keyring.roles (slug, name, description, scope, organization_id, space_id)
    VALUES (_slug_norm, btrim(_name), NULLIF(btrim(COALESCE(_description, '')), ''), 'customer', _org, NULL)
    ON CONFLICT (organization_id, slug) WHERE organization_id IS NOT NULL AND space_id IS NULL DO UPDATE SET
      name = EXCLUDED.name, description = EXCLUDED.description
    RETURNING id, slug, name, description, created_at INTO _row;
  ELSE
    INSERT INTO keyring.roles (slug, name, description, scope, organization_id, space_id)
    VALUES (_slug_norm, btrim(_name), NULLIF(btrim(COALESCE(_description, '')), ''), 'customer', _org, _space_id)
    ON CONFLICT (space_id, slug) WHERE space_id IS NOT NULL DO UPDATE SET
      name = EXCLUDED.name, description = EXCLUDED.description
    RETURNING id, slug, name, description, created_at INTO _row;
  END IF;
  _rid := _row.id;
  IF _permissions IS NOT NULL AND cardinality(_permissions) > 0 THEN
    FOREACH _perm IN ARRAY _permissions LOOP
      SELECT id INTO _pid FROM keyring.permissions
      WHERE slug = btrim(_perm) AND scope = 'customer' AND organization_id = _org
        AND space_id IS NOT DISTINCT FROM _space_id;
      INSERT INTO keyring.role_permissions (role_id, permission_id, organization_id, space_id)
      VALUES (_rid, _pid, _org, _space_id) ON CONFLICT (role_id, permission_id) DO NOTHING;
    END LOOP;
  END IF;
  RETURN json_build_object('slug', _row.slug, 'name', _row.name,
    'description', _row.description, 'space', _space, 'created_at', _row.created_at);
END $$;

CREATE OR REPLACE FUNCTION keyring.api_set_subject_attrs(
  _hash text, _subject text, _attrs jsonb, _display_name text DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _sid uuid;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _subject IS NULL OR btrim(_subject) = '' THEN RAISE EXCEPTION 'subject_required'; END IF;
  IF _attrs IS NULL OR jsonb_typeof(_attrs) <> 'object' THEN RAISE EXCEPTION 'invalid_attrs (want object)'; END IF;
  SELECT keyring.ensure_subject(_org, _subject, _display_name, _attrs) INTO _sid;
  UPDATE keyring.subjects SET attrs = attrs || _attrs WHERE id = _sid;
  RETURN true;
END $$;

DROP FUNCTION IF EXISTS keyring.api_provision_subject(text, text, text);
CREATE OR REPLACE FUNCTION keyring.api_provision_subject(
  _hash text, _subject text, _display_name text DEFAULT NULL, _space text DEFAULT NULL
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _rid uuid; _slug text; _spslug text; _space_id uuid; _sid uuid; _n int;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _subject IS NULL OR btrim(_subject) = '' THEN RAISE EXCEPTION 'invalid_subject:subject required'; END IF;
  SELECT keyring._resolve_space_id(_org, _space) INTO _space_id;
  IF _space_id IS NULL THEN
    SELECT default_role_id INTO _rid FROM keyring.organizations WHERE id = _org;
  ELSE
    SELECT default_role_id INTO _rid FROM keyring.spaces WHERE id = _space_id;
  END IF;
  IF _rid IS NULL THEN RAISE EXCEPTION 'no_default_role:set one via keyring_set_default_role'; END IF;
  SELECT slug, (SELECT slug FROM keyring.spaces WHERE id = _space_id) INTO _slug, _spslug FROM keyring.roles
  WHERE id = _rid AND scope = 'customer' AND organization_id = _org AND space_id IS NOT DISTINCT FROM _space_id;
  IF _slug IS NULL THEN RAISE EXCEPTION 'invalid_default_role:re-pick it via keyring_set_default_role'; END IF;
  SELECT keyring.ensure_subject(_org, btrim(_subject), _display_name) INTO _sid;
  IF _space_id IS NULL THEN
    INSERT INTO keyring.grants (organization_id, role_id, subject_id) VALUES (_org, _rid, _sid)
    ON CONFLICT (role_id, subject_id) WHERE space_id IS NULL DO NOTHING;
  ELSE
    INSERT INTO keyring.grants (organization_id, space_id, role_id, subject_id) VALUES (_org, _space_id, _rid, _sid)
    ON CONFLICT (role_id, subject_id, space_id) WHERE space_id IS NOT NULL DO NOTHING;
  END IF;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN json_build_object('subject', btrim(_subject), 'role', _slug, 'space', _spslug, 'granted', _n = 1);
END $$;

DROP FUNCTION IF EXISTS keyring.api_get_subject_access(text, text);
CREATE OR REPLACE FUNCTION keyring.api_get_subject_access(_hash text, _subject text, _space text DEFAULT NULL)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _sid uuid; _space_id uuid;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'check') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT keyring._resolve_space_id(_org, _space) INTO _space_id;
  SELECT id INTO _sid FROM keyring.subjects WHERE organization_id = _org AND external_id = _subject;
  IF _sid IS NULL THEN
    RETURN json_build_object('subject', _subject, 'space', _space, 'roles', '[]'::json, 'permissions', '[]'::json);
  END IF;
  RETURN json_build_object('subject', _subject, 'space', _space,
    'roles', COALESCE((SELECT json_agg(r.slug ORDER BY r.slug) FROM keyring.grants g
      JOIN keyring.roles r ON r.id = g.role_id
      WHERE g.organization_id = _org AND g.subject_id = _sid AND r.scope = 'customer'
        AND g.space_id IS NOT DISTINCT FROM _space_id AND r.space_id IS NOT DISTINCT FROM _space_id
        AND (g.expires_at IS NULL OR g.expires_at > now())), '[]'::json),
    'permissions', COALESCE((SELECT json_agg(DISTINCT p.slug ORDER BY p.slug) FROM keyring.grants g
      JOIN keyring.role_permissions rp ON rp.role_id = g.role_id
      JOIN keyring.permissions p ON p.id = rp.permission_id
      WHERE g.organization_id = _org AND g.subject_id = _sid AND p.scope = 'customer'
        AND g.space_id IS NOT DISTINCT FROM _space_id AND p.space_id IS NOT DISTINCT FROM _space_id
        AND (g.expires_at IS NULL OR g.expires_at > now())), '[]'::json));
END $$;

DROP FUNCTION IF EXISTS keyring.api_track_event(text, text, text, boolean, jsonb);
CREATE OR REPLACE FUNCTION keyring.api_track_event(
  _hash text, _subject text, _perm text, _allowed boolean DEFAULT NULL, _context jsonb DEFAULT '{}',
  _space text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _sid uuid; _pid uuid; _space_id uuid; _roles text[]; _resolved boolean;
  _store_as text; _telemetry_on boolean; _subject_mode text; _id uuid; _ctx jsonb;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'telemetry.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _subject IS NULL OR btrim(_subject) = '' THEN RAISE EXCEPTION 'subject_required'; END IF;
  IF _perm IS NULL OR btrim(_perm) = '' THEN RAISE EXCEPTION 'permission_required'; END IF;
  _ctx := COALESCE(_context, '{}');
  SELECT keyring._resolve_space_id(_org, _space) INTO _space_id;
  SELECT telemetry_enabled, telemetry_subject_mode INTO _telemetry_on, _subject_mode
  FROM keyring.organizations WHERE id = _org;
  IF NOT COALESCE(_telemetry_on, true) THEN RAISE EXCEPTION 'telemetry_disabled'; END IF;
  SELECT id INTO _sid FROM keyring.subjects WHERE organization_id = _org AND external_id = _subject;
  SELECT id INTO _pid FROM keyring.permissions WHERE organization_id = _org AND scope = 'customer' AND slug = _perm
    AND space_id IS NOT DISTINCT FROM _space_id;
  IF _allowed IS NULL THEN _resolved := keyring.has_permission_for_external(_org, _subject, _perm, _ctx, _space);
  ELSE _resolved := _allowed; END IF;
  IF _resolved THEN SELECT keyring._granting_role_slugs(_org, _subject, _perm, _ctx, _space) INTO _roles;
  ELSE _roles := '{}'; END IF;
  IF _subject_mode = 'hashed' THEN _store_as := encode(digest(_subject, 'sha256'), 'hex');
  ELSE _store_as := _subject; END IF;
  INSERT INTO keyring.check_events (organization_id, space_id, subject_id, subject_external_id,
    permission_id, permission_slug, matched_role_slugs, allowed, api_key_id, event_type, context)
  VALUES (_org, _space_id, _sid, _store_as, _pid, _perm, COALESCE(_roles, '{}'), _resolved, _key, 'custom', _ctx)
  RETURNING id INTO _id;
  RETURN _id;
END $$;

DROP FUNCTION IF EXISTS keyring.purge_expired_grants(text);
CREATE OR REPLACE FUNCTION keyring.purge_expired_grants(_hash text, _space text DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _org uuid; _key uuid; _space_id uuid; _n int;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  SELECT keyring._resolve_space_id(_org, _space) INTO _space_id;
  DELETE FROM keyring.grants WHERE organization_id = _org
    AND (_space IS NULL OR space_id IS NOT DISTINCT FROM _space_id)
    AND expires_at IS NOT NULL AND expires_at <= now();
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- §6 WEBHOOKS (fan-out + CRUD, tables locked by RLS — see §10)
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION keyring.webhook_event_matches(_subscribed text[], _event text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = keyring AS $$
  SELECT _subscribed IS NULL OR cardinality(_subscribed) = 0
    OR '*' = ANY (_subscribed) OR _event = ANY (_subscribed)
    OR (split_part(_event, '.', 1) || '.*') = ANY (_subscribed); $$;

CREATE OR REPLACE FUNCTION keyring.enqueue_webhook_event(_org uuid, _event text, _payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
BEGIN
  IF _org IS NULL THEN RETURN; END IF;
  INSERT INTO keyring.webhook_outbox (organization_id, endpoint_id, event, payload)
  SELECT _org, e.id, _event, COALESCE(_payload, '{}'::jsonb) FROM keyring.webhook_endpoints e
  WHERE e.organization_id = _org AND e.active AND keyring.webhook_event_matches(e.events, _event);
  UPDATE keyring.webhook_endpoints SET last_triggered_at = now()
  WHERE organization_id = _org AND active AND keyring.webhook_event_matches(events, _event);
END $$;

CREATE OR REPLACE FUNCTION keyring.trg_grants_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _event text; _payload jsonb; _role_slug text; _subject_ext text; _space_slug text;
BEGIN
  IF TG_OP = 'INSERT' THEN _event := 'grant.created';
  ELSIF TG_OP = 'DELETE' THEN _event := 'grant.deleted';
  ELSE _event := 'grant.updated'; END IF;
  SELECT slug INTO _role_slug FROM keyring.roles WHERE id = COALESCE(NEW.role_id, OLD.role_id);
  SELECT external_id INTO _subject_ext FROM keyring.subjects WHERE id = COALESCE(NEW.subject_id, OLD.subject_id);
  SELECT slug INTO _space_slug FROM keyring.spaces WHERE id = COALESCE(NEW.space_id, OLD.space_id);
  _payload := jsonb_build_object('subject', _subject_ext, 'role', _role_slug, 'space', _space_slug,
    'expires_at', COALESCE(NEW.expires_at, OLD.expires_at), 'grant_id', COALESCE(NEW.id, OLD.id));
  PERFORM keyring.enqueue_webhook_event(COALESCE(NEW.organization_id, OLD.organization_id), _event, _payload);
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS trg_webhook_grants ON keyring.grants;
CREATE TRIGGER trg_webhook_grants AFTER INSERT OR UPDATE OR DELETE ON keyring.grants
  FOR EACH ROW EXECUTE FUNCTION keyring.trg_grants_webhook();

CREATE OR REPLACE FUNCTION keyring.trg_subjects_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _event text;
BEGIN
  IF TG_OP = 'INSERT' THEN _event := 'subject.created';
  ELSIF TG_OP = 'DELETE' THEN _event := 'subject.deleted';
  ELSE _event := 'subject.updated'; END IF;
  PERFORM keyring.enqueue_webhook_event(COALESCE(NEW.organization_id, OLD.organization_id), _event,
    jsonb_build_object('subject', COALESCE(NEW.external_id, OLD.external_id),
      'display_name', COALESCE(NEW.display_name, OLD.display_name)));
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS trg_webhook_subjects ON keyring.subjects;
CREATE TRIGGER trg_webhook_subjects AFTER INSERT OR UPDATE OR DELETE ON keyring.subjects
  FOR EACH ROW EXECUTE FUNCTION keyring.trg_subjects_webhook();

CREATE OR REPLACE FUNCTION keyring.trg_roles_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _event text; _space_slug text;
BEGIN
  IF TG_OP = 'INSERT' THEN _event := 'role.created';
  ELSIF TG_OP = 'DELETE' THEN _event := 'role.deleted';
  ELSE _event := 'role.updated'; END IF;
  IF COALESCE(NEW.scope, OLD.scope) <> 'customer' THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT slug INTO _space_slug FROM keyring.spaces WHERE id = COALESCE(NEW.space_id, OLD.space_id);
  PERFORM keyring.enqueue_webhook_event(COALESCE(NEW.organization_id, OLD.organization_id), _event,
    jsonb_build_object('role', COALESCE(NEW.slug, OLD.slug), 'name', COALESCE(NEW.name, OLD.name),
      'space', _space_slug));
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS trg_webhook_roles ON keyring.roles;
CREATE TRIGGER trg_webhook_roles AFTER INSERT OR UPDATE OR DELETE ON keyring.roles
  FOR EACH ROW EXECUTE FUNCTION keyring.trg_roles_webhook();

CREATE OR REPLACE FUNCTION keyring.trg_permissions_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _event text; _space_slug text;
BEGIN
  IF TG_OP = 'INSERT' THEN _event := 'permission.created';
  ELSIF TG_OP = 'DELETE' THEN _event := 'permission.deleted';
  ELSE _event := 'permission.updated'; END IF;
  IF COALESCE(NEW.scope, OLD.scope) <> 'customer' THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT slug INTO _space_slug FROM keyring.spaces WHERE id = COALESCE(NEW.space_id, OLD.space_id);
  PERFORM keyring.enqueue_webhook_event(COALESCE(NEW.organization_id, OLD.organization_id), _event,
    jsonb_build_object('permission', COALESCE(NEW.slug, OLD.slug),
      'name', COALESCE(NEW.name, OLD.name), 'category', COALESCE(NEW.category, OLD.category),
      'space', _space_slug));
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS trg_webhook_permissions ON keyring.permissions;
CREATE TRIGGER trg_webhook_permissions AFTER INSERT OR UPDATE OR DELETE ON keyring.permissions
  FOR EACH ROW EXECUTE FUNCTION keyring.trg_permissions_webhook();

CREATE OR REPLACE FUNCTION keyring.trg_role_permissions_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _role_slug text; _perm_slug text;
BEGIN
  SELECT slug INTO _role_slug FROM keyring.roles WHERE id = COALESCE(NEW.role_id, OLD.role_id);
  SELECT slug INTO _perm_slug FROM keyring.permissions WHERE id = COALESCE(NEW.permission_id, OLD.permission_id);
  PERFORM keyring.enqueue_webhook_event(COALESCE(NEW.organization_id, OLD.organization_id),
    'role.permissions_updated',
    jsonb_build_object('role', _role_slug, 'permission', _perm_slug, 'op', TG_OP));
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS trg_webhook_role_permissions ON keyring.role_permissions;
CREATE TRIGGER trg_webhook_role_permissions AFTER INSERT OR DELETE ON keyring.role_permissions
  FOR EACH ROW EXECUTE FUNCTION keyring.trg_role_permissions_webhook();

CREATE OR REPLACE FUNCTION keyring.api_create_webhook_endpoint(
  _hash text, _name text, _url text, _secret text, _events text[] DEFAULT NULL
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _row record;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'webhooks.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _name IS NULL OR btrim(_name) = '' THEN RAISE EXCEPTION 'invalid_name:name required'; END IF;
  IF _url IS NULL OR _url NOT LIKE 'https://%' THEN RAISE EXCEPTION 'invalid_url:want https://…'; END IF;
  IF _secret IS NULL OR length(_secret) < 16 THEN RAISE EXCEPTION 'invalid_secret:min 16 chars'; END IF;
  INSERT INTO keyring.webhook_endpoints (organization_id, name, url, secret, events)
  VALUES (_org, btrim(_name), btrim(_url), _secret, COALESCE(_events, '{}'))
  RETURNING id, name, url, events, active, created_at INTO _row;
  RETURN json_build_object('id', _row.id, 'name', _row.name, 'url', _row.url,
    'events', _row.events, 'active', _row.active, 'created_at', _row.created_at);
END $$;

CREATE OR REPLACE FUNCTION keyring.api_list_webhook_endpoints(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'webhooks.read') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  RETURN COALESCE((SELECT json_agg(json_build_object('id', id, 'name', name, 'url', url,
    'events', events, 'active', active, 'failure_count', failure_count,
    'last_triggered_at', last_triggered_at, 'created_at', created_at) ORDER BY created_at)
    FROM keyring.webhook_endpoints WHERE organization_id = _org), '[]'::json);
END $$;

CREATE OR REPLACE FUNCTION keyring.api_delete_webhook_endpoint(_hash text, _id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'webhooks.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  DELETE FROM keyring.webhook_endpoints WHERE id = _id AND organization_id = _org;
  RETURN true;
END $$;

-- ── Space CRUD RPCs (key-authed, org-scoped) ───────────────────────────────
CREATE OR REPLACE FUNCTION keyring.api_create_space(
  _hash text, _slug text, _name text, _description text DEFAULT NULL
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _row record;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'spaces.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _slug IS NULL OR btrim(_slug) = '' THEN RAISE EXCEPTION 'invalid_slug:slug required'; END IF;
  IF lower(btrim(_slug)) !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN RAISE EXCEPTION 'invalid_slug:%', _slug; END IF;
  IF _name IS NULL OR btrim(_name) = '' THEN RAISE EXCEPTION 'invalid_name:name required'; END IF;
  INSERT INTO keyring.spaces (organization_id, slug, name, description)
  VALUES (_org, lower(btrim(_slug)), btrim(_name), NULLIF(btrim(COALESCE(_description, '')), ''))
  ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
  RETURNING id, slug, name, description, created_at INTO _row;
  RETURN json_build_object('id', _row.id, 'slug', _row.slug, 'name', _row.name,
    'description', _row.description, 'created_at', _row.created_at);
END $$;

CREATE OR REPLACE FUNCTION keyring.api_list_spaces(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'spaces.read') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  RETURN COALESCE((SELECT json_agg(json_build_object(
    'id', id, 'slug', slug, 'name', name, 'description', description, 'created_at', created_at
    ) ORDER BY created_at)
    FROM keyring.spaces WHERE organization_id = _org), '[]'::json);
END $$;

CREATE OR REPLACE FUNCTION keyring.api_delete_space(_hash text, _space text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _key uuid; _org uuid; _space_id uuid;
BEGIN
  SELECT keyring._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT keyring.api_key_has_scope(_key, 'spaces.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM keyring.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT keyring._resolve_space_id(_org, _space) INTO _space_id;
  IF _space_id IS NULL THEN RAISE EXCEPTION 'space_required'; END IF;
  DELETE FROM keyring.spaces WHERE id = _space_id AND organization_id = _org;
  RETURN true;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- §7 ORG-INTEGRITY TRIGGERS (workspace isolation; tables deny-all via RLS §9)
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION keyring.set_role_permission_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _r uuid; _p uuid; _rs uuid; _ps uuid;
BEGIN
  SELECT organization_id, space_id INTO _r, _rs FROM keyring.roles WHERE id = NEW.role_id;
  SELECT organization_id, space_id INTO _p, _ps FROM keyring.permissions WHERE id = NEW.permission_id;
  IF _r IS NULL AND _p IS NULL THEN NEW.organization_id := NULL; NEW.space_id := NULL;
  ELSIF _r IS NOT DISTINCT FROM _p AND _r IS NOT NULL AND _rs IS NOT DISTINCT FROM _ps THEN
    NEW.organization_id := _r; NEW.space_id := _rs;
  ELSE RAISE EXCEPTION 'Role and permission must belong to the same workspace and scope'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS set_role_permission_org ON keyring.role_permissions;
CREATE TRIGGER set_role_permission_org BEFORE INSERT OR UPDATE OF role_id, permission_id ON keyring.role_permissions
  FOR EACH ROW EXECUTE FUNCTION keyring.set_role_permission_org();

CREATE OR REPLACE FUNCTION keyring.set_grant_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _s uuid; _r uuid; _rs uuid;
BEGIN
  SELECT organization_id INTO _s FROM keyring.subjects WHERE id = NEW.subject_id;
  SELECT organization_id, space_id INTO _r, _rs FROM keyring.roles WHERE id = NEW.role_id;
  IF _s IS NULL OR _r IS NULL OR _s IS DISTINCT FROM _r THEN
    RAISE EXCEPTION 'Subject and role must belong to the same workspace'; END IF;
  IF _rs IS DISTINCT FROM NEW.space_id THEN
    RAISE EXCEPTION 'space_mismatch:role and grant must live in the same scope'; END IF;
  NEW.organization_id := _s;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS set_grant_org ON keyring.grants;
CREATE TRIGGER set_grant_org BEFORE INSERT OR UPDATE OF role_id, subject_id ON keyring.grants
  FOR EACH ROW EXECUTE FUNCTION keyring.set_grant_org();

CREATE OR REPLACE FUNCTION keyring.ensure_space_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
BEGIN
  IF NEW.space_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM keyring.spaces s
    WHERE s.id = NEW.space_id AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'space_mismatch:space belongs to another workspace';
  END IF;
  IF NEW.scope = 'console' AND NEW.space_id IS NOT NULL THEN
    RAISE EXCEPTION 'space_mismatch:console rows cannot live in a space';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ensure_space_org_roles ON keyring.roles;
CREATE TRIGGER ensure_space_org_roles
  BEFORE INSERT OR UPDATE OF space_id, organization_id, scope ON keyring.roles
  FOR EACH ROW EXECUTE FUNCTION keyring.ensure_space_org();
DROP TRIGGER IF EXISTS ensure_space_org_permissions ON keyring.permissions;
CREATE TRIGGER ensure_space_org_permissions
  BEFORE INSERT OR UPDATE OF space_id, organization_id, scope ON keyring.permissions
  FOR EACH ROW EXECUTE FUNCTION keyring.ensure_space_org();

CREATE OR REPLACE FUNCTION keyring.check_default_role_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = keyring AS $$
BEGIN
  IF NEW.default_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM keyring.roles WHERE id = NEW.default_role_id
      AND scope = 'customer' AND organization_id = NEW.id) THEN
    RAISE EXCEPTION 'invalid_default_role:must be a customer role of this workspace'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_check_default_role_org ON keyring.organizations;
CREATE TRIGGER trg_check_default_role_org BEFORE INSERT OR UPDATE OF default_role_id ON keyring.organizations
  FOR EACH ROW EXECUTE FUNCTION keyring.check_default_role_org();

CREATE OR REPLACE FUNCTION keyring.check_space_default_role_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = keyring AS $$
BEGIN
  IF NEW.default_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM keyring.roles WHERE id = NEW.default_role_id
      AND scope = 'customer' AND organization_id = NEW.organization_id
      AND space_id IS NOT DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION 'invalid_default_role:must be a customer role of this space'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_check_space_default_role_org ON keyring.spaces;
CREATE TRIGGER trg_check_space_default_role_org
  BEFORE INSERT OR UPDATE OF default_role_id ON keyring.spaces
  FOR EACH ROW EXECUTE FUNCTION keyring.check_space_default_role_org();

-- ══════════════════════════════════════════════════════════════════════
-- §8 BOOTSTRAP (no login required — hash comes from the caller)
-- ══════════════════════════════════════════════════════════════════════
--
-- _key_hash = lowercase hex SHA-256 of the raw key (compute app-side:
--   echo -n "$KR_KEY" | sha256sum). _prefix = first 12 chars of the raw key.
-- Scopes default to the full built-in set (root key). Returns the org id +
-- key id so scripts can chain permission/role creation.

CREATE OR REPLACE FUNCTION keyring.keyring_bootstrap(
  _slug text, _name text, _key_hash text, _prefix text,
  _key_name text DEFAULT 'root'
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _org uuid; _key uuid;
BEGIN
  IF _slug IS NULL OR btrim(_slug) = '' THEN RAISE EXCEPTION 'slug_required'; END IF;
  IF _key_hash IS NULL OR _key_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_key_hash:want sha256 hex'; END IF;
  IF _prefix IS NULL OR length(_prefix) < 8 THEN RAISE EXCEPTION 'invalid_prefix'; END IF;
  INSERT INTO keyring.organizations (slug, name)
  VALUES (lower(btrim(_slug)), btrim(COALESCE(NULLIF(_name, ''), _slug)))
  ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO _org;
  INSERT INTO keyring.api_keys (name, key_hash, prefix, key_type, scopes, organization_id)
  VALUES (COALESCE(NULLIF(btrim(COALESCE(_key_name, 'root')), ''), 'root'),
    _key_hash, _prefix, 'secret',
    ARRAY['check','grants.write','roles.read','roles.write','spaces.read','spaces.write',
      'actions.read','actions.write',
      'subject_tokens.write','telemetry.read','telemetry.write',
      'webhooks.read','webhooks.write','integrations.write'],
    _org)
  ON CONFLICT (key_hash) DO NOTHING
  RETURNING id INTO _key;
  RETURN json_build_object('organization_id', _org, 'key_id', _key, 'slug', lower(btrim(_slug)));
END $$;

CREATE OR REPLACE FUNCTION keyring.keyring_issue_key(
  _org_slug text, _name text, _key_hash text, _prefix text,
  _scopes text[] DEFAULT ARRAY['check'], _key_type text DEFAULT 'secret'
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _org uuid; _id uuid;
BEGIN
  SELECT id INTO _org FROM keyring.organizations WHERE slug = lower(btrim(_org_slug));
  IF _org IS NULL THEN RAISE EXCEPTION 'unknown_organization:%', _org_slug; END IF;
  IF _key_hash IS NULL OR _key_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_key_hash:want sha256 hex'; END IF;
  INSERT INTO keyring.api_keys (name, key_hash, prefix, key_type, scopes, organization_id)
  VALUES (_name, _key_hash, _prefix, _key_type, COALESCE(_scopes, ARRAY['check']), _org)
  RETURNING id INTO _id;
  RETURN _id;
END $$;

DROP FUNCTION IF EXISTS keyring.keyring_set_default_role(text, text);
CREATE OR REPLACE FUNCTION keyring.keyring_set_default_role(_org_slug text, _role_slug text, _space_slug text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = keyring AS $$
DECLARE _org uuid; _space_id uuid; _rid uuid;
BEGIN
  SELECT id INTO _org FROM keyring.organizations WHERE slug = lower(btrim(_org_slug));
  IF _org IS NULL THEN RAISE EXCEPTION 'unknown_organization:%', _org_slug; END IF;
  SELECT keyring._resolve_space_id(_org, _space_slug) INTO _space_id;
  SELECT id INTO _rid FROM keyring.roles
  WHERE slug = _role_slug AND scope = 'customer' AND organization_id = _org
    AND space_id IS NOT DISTINCT FROM _space_id;
  IF _rid IS NULL THEN RAISE EXCEPTION 'unknown_role:%', _role_slug; END IF;
  IF _space_id IS NULL THEN
    UPDATE keyring.organizations SET default_role_id = _rid WHERE id = _org;
  ELSE
    UPDATE keyring.spaces SET default_role_id = _rid WHERE id = _space_id;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- §9 SUPABASE HARDENING (RLS lock-down + least-privilege RPC surface)
-- ══════════════════════════════════════════════════════════════════════
--
-- Applied always (harmless on vanilla Postgres), required when the `keyring`
-- schema is exposed via PostgREST:
--   - RLS enabled on every table with NO policies: direct anon/authenticated
--     table reads/writes are denied. SECURITY DEFINER functions run as the
--     table owner and bypass RLS, so the key-hash authed api_* RPCs keep
--     working. This is the same model as the hosted stack (deny tables,
--     allow key-authed RPCs).
--   - Internal/keyless/trigger/bootstrap helpers are revoked from PUBLIC
--     (and from anon/authenticated/service_role where those roles exist).
--     The public api_* RPCs stay executable by anon/authenticated on purpose:
--     the publishable key + per-op scope check inside each function IS the
--     auth (bad/revoked key -> NULL -> 401). The hosted schema does exactly
--     the same, so the linter will still list api_* under the
--     *_security_definer_function_executable WARNs — that is expected.
--   - Covering indexes for every FK (silences unindexed_foreign_keys).
-- All role-targeted statements are guarded by pg_roles checks so this file
-- still applies on vanilla Postgres where anon/authenticated/service_role
-- do not exist.

ALTER TABLE keyring.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyring.spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyring.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyring.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyring.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyring.subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyring.grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyring.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyring.check_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyring.webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyring.webhook_outbox ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS check_events_api_key_id_idx ON keyring.check_events (api_key_id);
CREATE INDEX IF NOT EXISTS check_events_permission_id_idx ON keyring.check_events (permission_id);
CREATE INDEX IF NOT EXISTS check_events_subject_id_idx ON keyring.check_events (subject_id);
CREATE INDEX IF NOT EXISTS grants_subject_id_idx ON keyring.grants (subject_id);
CREATE INDEX IF NOT EXISTS role_permissions_permission_id_idx ON keyring.role_permissions (permission_id);
CREATE INDEX IF NOT EXISTS webhook_outbox_endpoint_id_idx ON keyring.webhook_outbox (endpoint_id);
CREATE INDEX IF NOT EXISTS organizations_default_role_idx ON keyring.organizations (default_role_id);

-- Internal helpers: never callable via PostgREST. REVOKE FROM PUBLIC always
-- applies (vanilla + Supabase); nested calls from api_* still work because
-- SECURITY DEFINER runs them as the table owner.
REVOKE ALL ON FUNCTION keyring._api_key_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.api_key_has_scope(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring._abac_lookup(text, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring._abac_clause_matches(jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring._abac_condition_matches(jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.ensure_subject(uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.has_role(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.has_permission(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.has_permission_for_external(uuid, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring._granting_role_slugs(uuid, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.enqueue_webhook_event(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.set_role_permission_org() FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.ensure_space_org() FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.set_grant_org() FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.check_default_role_org() FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.check_space_default_role_org() FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring._resolve_space_id(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.guard_api_key_scopes() FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.trg_grants_webhook() FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.trg_subjects_webhook() FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.trg_roles_webhook() FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.trg_permissions_webhook() FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.trg_role_permissions_webhook() FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.keyring_bootstrap(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.keyring_issue_key(text, text, text, text, text[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION keyring.keyring_set_default_role(text, text, text) FROM PUBLIC;

-- Supabase roles only: strip internals, open the key-authed public RPCs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT USAGE ON SCHEMA keyring TO anon, authenticated;
    REVOKE ALL ON TABLE keyring.organizations, keyring.spaces, keyring.roles, keyring.permissions,
      keyring.role_permissions, keyring.subjects, keyring.grants, keyring.api_keys,
      keyring.check_events, keyring.webhook_endpoints, keyring.webhook_outbox
      FROM anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_key_meta(text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_whoami(text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_check(text, text, text, jsonb, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_grant_role(text, text, text, text, timestamptz, int, jsonb, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_revoke_grant(text, text, text, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_list_roles(text, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_list_permissions(text, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_create_permission(text, text, text, text, text, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_create_role(text, text, text, text, text[], text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_set_subject_attrs(text, text, jsonb, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_provision_subject(text, text, text, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_get_subject_access(text, text, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_track_event(text, text, text, boolean, jsonb, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.purge_expired_grants(text, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_create_webhook_endpoint(text, text, text, text, text[]) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_list_webhook_endpoints(text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_delete_webhook_endpoint(text, uuid) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_create_space(text, text, text, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_list_spaces(text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION keyring.api_delete_space(text, text) TO anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION keyring.api_key_meta(text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_whoami(text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_check(text, text, text, jsonb, text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_grant_role(text, text, text, text, timestamptz, int, jsonb, text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_revoke_grant(text, text, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_list_roles(text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_list_permissions(text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_create_permission(text, text, text, text, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_create_role(text, text, text, text, text[], text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_set_subject_attrs(text, text, jsonb, text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_provision_subject(text, text, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_get_subject_access(text, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_track_event(text, text, text, boolean, jsonb, text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.purge_expired_grants(text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_create_webhook_endpoint(text, text, text, text, text[]) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_list_webhook_endpoints(text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_delete_webhook_endpoint(text, uuid) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_create_space(text, text, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_list_spaces(text) TO service_role;
    GRANT EXECUTE ON FUNCTION keyring.api_delete_space(text, text) TO service_role;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- §10 VERIFICATION (read the output after running)
-- ══════════════════════════════════════════════════════════════════════

SELECT 'tables' AS check, tablename AS name FROM pg_tables
WHERE schemaname = 'keyring' AND tablename IN ('organizations','spaces','roles','permissions',
  'role_permissions','subjects','grants','api_keys','check_events',
  'webhook_endpoints','webhook_outbox') ORDER BY tablename;
SELECT 'supabase_refs' AS check, count(*) AS count FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'keyring' AND p.prokind = 'f'
  AND pg_get_functiondef(p.oid) ILIKE '%auth.uid()%';
SELECT 'rls_off' AS check, tablename AS name FROM pg_tables t
WHERE schemaname = 'keyring' AND tablename IN ('organizations','spaces','roles','permissions',
  'role_permissions','subjects','grants','api_keys','check_events',
  'webhook_endpoints','webhook_outbox')
  AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = t.tablename AND n.nspname = 'keyring' AND c.relrowsecurity);
SELECT 'space_columns' AS check, table_name AS name FROM information_schema.columns
WHERE table_schema = 'keyring' AND column_name = 'space_id'
  AND table_name IN ('roles', 'permissions', 'role_permissions', 'grants', 'check_events')
ORDER BY table_name;
