-- KEYRING FULL SCHEMA (SQUASHED)
--
-- Single-file equivalent of migrations 0000–0013 for FRESH databases only.
-- Databases that already applied any 0000–0012 file must keep applying
-- incrementally and MUST NOT run this file (it is not backfill-aware).
--
-- What it builds, end state:
--   Workspace isolation: every customer-plane row (roles, permissions,
--     role_permissions, subjects, grants, audit_log) is owned by exactly one
--     organization_id; the console plane (scope='console') stays global.
--     Slugs/external_ids are unique per workspace, not globally.
--   Membership: profiles.organization_id is the edge; joins require an
--     approved organization_join_requests row (guard_profile_org_change
--     blocks every other path; decide_join_request links via bypass flag).
--   Console access: invisible console-scope roles/permissions granted through
--     member_roles; creators bypass; reads gated by roles.read /
--     permissions.read / users.read / members.read / audit.read.
--   Billing: Polar MoR. user_subscriptions gates workspace creation
--     (subscribed create organizations); webhooks sync via sync_subscription.
--   Management API: key-hash authed SECURITY DEFINER functions, every lookup
--     scoped to the calling key's organization_id. No service_role anywhere
--     in this stack (edge functions are the documented exception).
--
-- Apply in the Supabase SQL editor on an empty project, then follow the
-- Polar setup in 0010's header (products, webhook, edge-function secrets).

-- ══════════════════════════════════════════════════════════════════════════
-- §1 TABLES
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  avatar_url text,
  website text,
  support_email text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_reserved_check CHECK (
    slug NOT IN ('account')
  )
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text,
  avatar_url text,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS profiles_organization_id_idx ON public.profiles (organization_id);

CREATE TABLE public.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'customer' CHECK (scope IN ('customer', 'console')),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_scope_org_check CHECK (
    (scope = 'console' AND organization_id IS NULL)
    OR (scope = 'customer' AND organization_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_slug_global_uniq
  ON public.roles (slug) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS roles_slug_org_uniq
  ON public.roles (organization_id, slug) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS roles_organization_id_idx ON public.roles (organization_id);

CREATE TABLE public.permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'general',
  is_system boolean NOT NULL DEFAULT false,
  scope text NOT NULL DEFAULT 'customer' CHECK (scope IN ('customer', 'console')),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permissions_scope_org_check CHECK (
    (scope = 'console' AND organization_id IS NULL)
    OR (scope = 'customer' AND organization_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS permissions_slug_global_uniq
  ON public.permissions (slug) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS permissions_slug_org_uniq
  ON public.permissions (organization_id, slug) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS permissions_organization_id_idx ON public.permissions (organization_id);

CREATE TABLE public.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, permission_id)
);
CREATE INDEX IF NOT EXISTS role_permissions_organization_id_idx ON public.role_permissions (organization_id);

CREATE TABLE public.subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL,
  display_name text,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subjects_external_org_uniq
  ON public.subjects (organization_id, external_id);
CREATE INDEX IF NOT EXISTS subjects_organization_id_idx ON public.subjects (organization_id);

CREATE TABLE public.grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (role_id, subject_id)
);
CREATE INDEX IF NOT EXISTS grants_organization_id_idx ON public.grants (organization_id);
CREATE INDEX IF NOT EXISTS grants_expires_at_idx
  ON public.grants (organization_id, expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE public.member_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, role_id)
);
CREATE INDEX IF NOT EXISTS member_roles_organization_id_idx
  ON public.member_roles (organization_id);

CREATE TABLE public.organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, organization_id)
);
CREATE INDEX IF NOT EXISTS organization_members_org_idx
  ON public.organization_members (organization_id);
CREATE INDEX IF NOT EXISTS organization_members_profile_idx
  ON public.organization_members (profile_id);

CREATE TABLE public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  action text NOT NULL,
  target text,
  detail text,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_organization_id_idx ON public.audit_log (organization_id);

CREATE TABLE public.organization_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS join_requests_one_pending_idx
  ON public.organization_join_requests (organization_id, profile_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS join_requests_org_idx
  ON public.organization_join_requests (organization_id) WHERE status = 'pending';

CREATE TABLE public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  key_type text NOT NULL DEFAULT 'secret'
    CHECK (key_type IN ('secret', 'publishable')),
  -- Built-in Management API scopes (check, grants.write, roles.read, roles.write,
  -- actions.read, actions.write, subject_tokens.write, telemetry.read, telemetry.write)
  scopes text[] NOT NULL DEFAULT '{}',
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE public.subscription_plans (
  code text PRIMARY KEY CHECK (code IN ('free', 'pro', 'enterprise')),
  name text NOT NULL,
  monthly_price_cents integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.user_subscriptions (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'past_due', 'canceled')),
  provider_subscription_id text,
  provider_customer_id text,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.billing_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'polar',
  provider_customer_id text NOT NULL,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_customer_id),
  UNIQUE (provider, user_id)
);

CREATE TABLE public.billing_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'polar',
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS billing_webhook_events_unprocessed_idx
  ON public.billing_webhook_events (processed_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS billing_customers_user_idx
  ON public.billing_customers (user_id);

-- Waitlist (private beta): locked-down table, access only through
-- SECURITY DEFINER functions granted to anon + authenticated.
-- Enroll via: UPDATE public.waitlist_emails SET status='approved',
-- approved_at=now() WHERE lower(email)=lower('friend@example.com');
CREATE TABLE public.waitlist_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_emails_lower_uniq
  ON public.waitlist_emails (lower(email));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT ALL ON public.organizations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.roles TO authenticated;
GRANT ALL ON public.roles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.permissions TO authenticated;
GRANT ALL ON public.permissions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permissions TO authenticated;
GRANT ALL ON public.role_permissions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subjects TO authenticated;
GRANT ALL ON public.subjects TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.grants TO authenticated;
GRANT ALL ON public.grants TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_roles TO authenticated;
GRANT ALL ON public.member_roles TO service_role;
GRANT SELECT ON public.organization_members TO authenticated;
GRANT ALL ON public.organization_members TO service_role;
GRANT SELECT, INSERT ON public.audit_log TO authenticated;
GRANT ALL ON public.audit_log TO service_role;
GRANT SELECT, INSERT, DELETE ON public.organization_join_requests TO authenticated;
GRANT ALL ON public.organization_join_requests TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_keys TO authenticated;
GRANT ALL ON public.api_keys TO service_role;
GRANT SELECT ON public.subscription_plans TO anon, authenticated;
GRANT SELECT ON public.user_subscriptions TO authenticated;
GRANT SELECT ON public.billing_customers TO authenticated;
GRANT ALL ON public.waitlist_emails TO service_role;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_webhook_events ENABLE ROW LEVEL SECURITY;
-- Waitlist table is locked down: no direct anon/authenticated access.
-- All reads/writes go through join_waitlist / waitlist_status /
-- is_waitlist_approved (SECURITY DEFINER, granted below).
ALTER TABLE public.waitlist_emails ENABLE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════════════════════════════════
-- §2 SEEDS (invisible console plane + plan catalog)
-- ══════════════════════════════════════════════════════════════════════════

INSERT INTO public.permissions (slug, name, description, category, is_system, scope) VALUES
  ('users.manage', 'Manage members', 'Grant console roles and remove members.', 'Console', true, 'console'),
  ('roles.manage', 'Manage roles', 'Create, edit and delete customer roles.', 'Console', true, 'console'),
  ('permissions.manage', 'Manage actions', 'Create, edit and delete customer actions.', 'Console', true, 'console'),
  ('organizations.manage', 'Manage organization', 'Edit organization profile and membership.', 'Console', true, 'console'),
  ('audit.read', 'Read audit log', 'View the activity log.', 'Console', true, 'console'),
  ('roles.read', 'View roles', 'See customer roles and the role matrix.', 'Console', true, 'console'),
  ('permissions.read', 'View actions', 'See customer actions.', 'Console', true, 'console'),
  ('users.read', 'View users', 'See subjects and their grants.', 'Console', true, 'console'),
  ('members.read', 'View members', 'See workspace members and join requests.', 'Console', true, 'console')
ON CONFLICT DO NOTHING;

INSERT INTO public.roles (slug, name, description, is_system, scope) VALUES
  ('console-manager', 'Manager', 'Full console access. Invisible in customer lists.', true, 'console'),
  ('console-viewer', 'Viewer', 'Read-only console access. Invisible in customer lists.', true, 'console')
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.slug = 'console-manager' AND r.scope = 'console' AND p.scope = 'console'
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.slug = 'console-viewer' AND r.scope = 'console'
  AND p.scope = 'console' AND p.slug LIKE '%read'
ON CONFLICT DO NOTHING;

INSERT INTO public.subscription_plans (code, name, monthly_price_cents, is_active) VALUES
  ('free', 'Self-hosted', 0, true),
  ('pro', 'Pro', 1200, true),
  ('enterprise', 'Enterprise', 0, true)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name,
  monthly_price_cents = EXCLUDED.monthly_price_cents, is_active = true;

-- ══════════════════════════════════════════════════════════════════════════
-- §3 FUNCTIONS
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.my_organization_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.is_org_member(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = _user_id AND organization_id IS NOT NULL
  )
$$;

CREATE OR REPLACE FUNCTION public.am_org_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organizations WHERE created_by = auth.uid())
$$;

CREATE OR REPLACE FUNCTION public.has_console_permission(_user_id uuid, _perm text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organizations o
    JOIN public.profiles me ON me.id = _user_id
    WHERE o.created_by = _user_id AND o.id = me.organization_id
  )
  OR EXISTS (
    SELECT 1 FROM public.member_roles mr
    JOIN public.profiles me ON me.id = mr.profile_id
    JOIN public.role_permissions rp ON rp.role_id = mr.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    JOIN public.roles r ON r.id = mr.role_id
    WHERE mr.profile_id = _user_id
      AND me.organization_id IS NOT NULL
      AND mr.organization_id = me.organization_id
      AND r.scope = 'console' AND p.scope = 'console' AND p.slug = _perm
  )
$$;

CREATE OR REPLACE FUNCTION public.my_console_permissions()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(p.slug), '{}')
  FROM public.member_roles mr
  JOIN public.role_permissions rp ON rp.role_id = mr.role_id
  JOIN public.permissions p ON p.id = rp.permission_id
  JOIN public.roles r ON r.id = mr.role_id
  JOIN public.profiles me ON me.id = mr.profile_id
  WHERE mr.profile_id = auth.uid()
    AND me.organization_id IS NOT NULL
    AND mr.organization_id = me.organization_id
    AND r.scope = 'console' AND p.scope = 'console'
$$;

CREATE OR REPLACE FUNCTION public.is_org_manager(_user_id uuid, _org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organizations WHERE id = _org_id AND created_by = _user_id)
  OR (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = _user_id AND organization_id = _org_id)
    AND EXISTS (
      SELECT 1 FROM public.member_roles mr
      JOIN public.role_permissions rp ON rp.role_id = mr.role_id
      JOIN public.permissions p ON p.id = rp.permission_id
      JOIN public.roles r ON r.id = mr.role_id
      WHERE mr.profile_id = _user_id
        AND mr.organization_id = _org_id
        AND r.scope = 'console' AND p.scope = 'console'
        AND p.slug IN ('users.manage', 'organizations.manage')
    )
  )
$$;

-- Expired grants (expires_at <= now()) never authorize. NULL = permanent.
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

CREATE OR REPLACE FUNCTION public.ensure_subject(
  _organization_id uuid,
  _external_id text,
  _display_name text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
BEGIN
  IF _organization_id IS NULL THEN
    RAISE EXCEPTION 'Organization is required';
  END IF;
  INSERT INTO public.subjects (organization_id, external_id, display_name)
  VALUES (_organization_id, _external_id, NULLIF(_display_name, ''))
  ON CONFLICT (organization_id, external_id) DO UPDATE
    SET display_name = COALESCE(EXCLUDED.display_name, public.subjects.display_name)
  RETURNING id INTO _id;
  RETURN _id;
END;
$$;

CREATE OR REPLACE FUNCTION public.request_to_join_org(_slug text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org_id uuid;
  _existing uuid;
BEGIN
  SELECT id INTO _org_id FROM public.organizations
  WHERE slug = lower(trim(_slug));
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'No organization found for slug "%"', trim(_slug);
  END IF;
  IF EXISTS (SELECT 1 FROM public.organization_members
             WHERE profile_id = auth.uid() AND organization_id = _org_id) THEN
    RAISE EXCEPTION 'You already belong to this workspace';
  END IF;
  SELECT id INTO _existing FROM public.organization_join_requests
  WHERE profile_id = auth.uid() AND organization_id = _org_id AND status = 'pending';
  IF _existing IS NOT NULL THEN
    RETURN _existing;
  END IF;
  INSERT INTO public.organization_join_requests (organization_id, profile_id)
  VALUES (_org_id, auth.uid())
  RETURNING id INTO _existing;
  RETURN _existing;
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_join_request(_request_id uuid, _approve boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org_id uuid;
  _profile_id uuid;
  _status text;
BEGIN
  SELECT organization_id, profile_id, status
    INTO _org_id, _profile_id, _status
  FROM public.organization_join_requests WHERE id = _request_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
  IF _status <> 'pending' THEN
    RAISE EXCEPTION 'Request already decided';
  END IF;
  IF NOT public.is_org_manager(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Only workspace managers can decide join requests';
  END IF;
  IF _approve THEN
    INSERT INTO public.organization_members (organization_id, profile_id)
    VALUES (_org_id, _profile_id)
    ON CONFLICT (profile_id, organization_id) DO NOTHING;
    PERFORM set_config('app.org_link_bypass', 'on', true);
    UPDATE public.profiles SET organization_id = _org_id WHERE id = _profile_id;
  END IF;
  UPDATE public.organization_join_requests
  SET status = CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,
      decided_at = now(),
      decided_by = auth.uid()
  WHERE id = _request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.switch_organization(_organization_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE profile_id = auth.uid() AND organization_id = _organization_id
  ) THEN
    RAISE EXCEPTION 'Not a member of this workspace';
  END IF;
  PERFORM set_config('app.org_link_bypass', 'on', true);
  UPDATE public.profiles SET organization_id = _organization_id WHERE id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_member(_profile_id uuid, _organization_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (
    public.is_org_manager(auth.uid(), _organization_id) OR auth.uid() = _profile_id
  ) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = _organization_id AND created_by = _profile_id
  ) THEN
    RAISE EXCEPTION 'Cannot remove the workspace owner';
  END IF;
  DELETE FROM public.member_roles
  WHERE profile_id = _profile_id AND organization_id = _organization_id;
  DELETE FROM public.organization_members
  WHERE profile_id = _profile_id AND organization_id = _organization_id;
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = _profile_id AND organization_id = _organization_id
  ) THEN
    PERFORM set_config('app.org_link_bypass', 'on', true);
    UPDATE public.profiles SET organization_id = (
      SELECT organization_id FROM public.organization_members
      WHERE profile_id = _profile_id ORDER BY created_at LIMIT 1
    ) WHERE id = _profile_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.grant_creator_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.created_by IS NOT NULL THEN
    INSERT INTO public.organization_members (organization_id, profile_id)
    VALUES (NEW.id, NEW.created_by)
    ON CONFLICT (profile_id, organization_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_profile_org_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.org_link_bypass', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS NULL AND OLD.id = auth.uid() THEN
    RETURN NEW;
  END IF;
  IF OLD.id = auth.uid() AND NEW.organization_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.organizations
                 WHERE id = NEW.organization_id AND created_by = auth.uid()) THEN
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS NULL AND OLD.organization_id IS NOT NULL
     AND public.is_org_manager(auth.uid(), OLD.organization_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Organization membership can only change via join approval';
END;
$$;

CREATE OR REPLACE FUNCTION public.set_role_permission_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _r uuid;
  _p uuid;
BEGIN
  SELECT organization_id INTO _r FROM public.roles WHERE id = NEW.role_id;
  SELECT organization_id INTO _p FROM public.permissions WHERE id = NEW.permission_id;
  IF _r IS NULL AND _p IS NULL THEN
    NEW.organization_id := NULL;
  ELSIF _r IS NOT DISTINCT FROM _p AND _r IS NOT NULL THEN
    NEW.organization_id := _r;
  ELSE
    RAISE EXCEPTION 'Role and permission must belong to the same workspace';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_grant_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _s uuid;
  _r uuid;
BEGIN
  SELECT organization_id INTO _s FROM public.subjects WHERE id = NEW.subject_id;
  SELECT organization_id INTO _r FROM public.roles WHERE id = NEW.role_id;
  IF _s IS NULL OR _r IS NULL OR _s IS DISTINCT FROM _r THEN
    RAISE EXCEPTION 'Subject and role must belong to the same workspace';
  END IF;
  NEW.organization_id := _s;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fill_audit_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    SELECT organization_id INTO NEW.organization_id
    FROM public.profiles WHERE id = NEW.actor_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, COALESCE(NEW.email, ''), NEW.raw_user_meta_data ->> 'full_name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_subscription(
  p_user_id uuid,
  p_plan text,
  p_status text,
  p_provider_subscription_id text DEFAULT NULL,
  p_provider_customer_id text DEFAULT NULL,
  p_cancel_at_period_end boolean DEFAULT false
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_plan NOT IN ('free', 'pro', 'enterprise') THEN
    RAISE EXCEPTION 'Unknown plan: %', p_plan;
  END IF;
  IF p_status NOT IN ('active', 'past_due', 'canceled') THEN
    RAISE EXCEPTION 'Unknown status: %', p_status;
  END IF;
  INSERT INTO public.user_subscriptions
    (user_id, plan, status, provider_subscription_id, provider_customer_id,
     cancel_at_period_end, updated_at)
  VALUES (p_user_id, p_plan, p_status, p_provider_subscription_id,
    p_provider_customer_id, p_cancel_at_period_end, now())
  ON CONFLICT (user_id) DO UPDATE SET
    plan = EXCLUDED.plan,
    status = EXCLUDED.status,
    provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id,
      public.user_subscriptions.provider_subscription_id),
    provider_customer_id = COALESCE(EXCLUDED.provider_customer_id,
      public.user_subscriptions.provider_customer_id),
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.has_active_subscription(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_subscriptions
    WHERE user_id = _user_id
      AND plan IN ('pro', 'enterprise')
      AND status = 'active'
  )
$$;

CREATE OR REPLACE FUNCTION public.join_waitlist(_email text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _clean text;
  _status text;
BEGIN
  _clean := lower(trim(BOTH ' ' FROM COALESCE(_email, '')));
  IF _clean = '' OR _clean NOT LIKE '%@%.%' OR length(_clean) > 320 THEN
    RAISE EXCEPTION 'Invalid email address';
  END IF;
  INSERT INTO public.waitlist_emails (email, status)
  VALUES (_clean, 'pending')
  ON CONFLICT (lower(email)) DO NOTHING;
  SELECT status INTO _status FROM public.waitlist_emails
  WHERE lower(email) = _clean;
  RETURN COALESCE(_status, 'pending');
END;
$$;

CREATE OR REPLACE FUNCTION public.waitlist_status(_email text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _status text;
BEGIN
  SELECT status INTO _status FROM public.waitlist_emails
  WHERE lower(email) = lower(trim(BOTH ' ' FROM COALESCE(_email, '')));
  RETURN _status;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_waitlist_approved(_email text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.waitlist_emails
    WHERE lower(email) = lower(trim(BOTH ' ' FROM COALESCE(_email, '')))
      AND status = 'approved'
  )
$$;

GRANT EXECUTE ON FUNCTION public.join_waitlist(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.waitlist_status(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_waitlist_approved(text) TO anon, authenticated, service_role;

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
GRANT EXECUTE ON FUNCTION public.api_key_meta(text) TO anon, authenticated, service_role;

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

-- ══════════════════════════════════════════════════════════════════════════
-- §4 TRIGGERS
-- ══════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

DROP TRIGGER IF EXISTS grant_creator_membership ON public.organizations;
CREATE TRIGGER grant_creator_membership
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.grant_creator_membership();

DROP TRIGGER IF EXISTS guard_profile_org_change ON public.profiles;
CREATE TRIGGER guard_profile_org_change
  BEFORE UPDATE OF organization_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_org_change();

DROP TRIGGER IF EXISTS set_role_permission_org ON public.role_permissions;
CREATE TRIGGER set_role_permission_org
  BEFORE INSERT OR UPDATE OF role_id, permission_id ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_role_permission_org();

DROP TRIGGER IF EXISTS set_grant_org ON public.grants;
CREATE TRIGGER set_grant_org
  BEFORE INSERT OR UPDATE OF role_id, subject_id ON public.grants
  FOR EACH ROW EXECUTE FUNCTION public.set_grant_org();

DROP TRIGGER IF EXISTS fill_audit_org ON public.audit_log;
CREATE TRIGGER fill_audit_org
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.fill_audit_org();

DROP TRIGGER IF EXISTS trg_guard_api_key_scopes ON public.api_keys;
CREATE TRIGGER trg_guard_api_key_scopes
  BEFORE INSERT OR UPDATE OF scopes, key_type ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.guard_api_key_scopes();

-- ══════════════════════════════════════════════════════════════════════════
-- §5 POLICIES (final state: workspace isolation + read perms + billing)
-- ══════════════════════════════════════════════════════════════════════════

-- profiles
DROP POLICY IF EXISTS "insert own profile" ON public.profiles;
CREATE POLICY "insert own profile" ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());
DROP POLICY IF EXISTS "read own or same organization" ON public.profiles;
CREATE POLICY "read own or same organization" ON public.profiles FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR (
      organization_id IS NOT NULL
      AND organization_id = public.my_organization_id()
      AND (
        public.is_org_manager(auth.uid(), organization_id)
        OR public.has_console_permission(auth.uid(), 'members.read')
        OR public.has_console_permission(auth.uid(), 'users.manage')
      )
    )
    OR EXISTS (
      SELECT 1 FROM public.organization_join_requests r
      WHERE r.profile_id = public.profiles.id
        AND r.status = 'pending'
        AND r.organization_id = public.my_organization_id()
        AND public.is_org_manager(auth.uid(), r.organization_id)
    )
  );
DROP POLICY IF EXISTS "update own or manage member" ON public.profiles;
DROP POLICY IF EXISTS "update own or unlink member" ON public.profiles;
DROP POLICY IF EXISTS "update own profile" ON public.profiles;
CREATE POLICY "update own or manage member" ON public.profiles FOR UPDATE TO authenticated
  USING (
    id = auth.uid()
    OR (organization_id IS NOT NULL AND organization_id = public.my_organization_id()
        AND public.has_console_permission(auth.uid(), 'users.manage'))
  )
  WITH CHECK (id = auth.uid() OR organization_id IS NULL);

-- organizations
DROP POLICY IF EXISTS "authenticated read organizations" ON public.organizations;
CREATE POLICY "org read organizations" ON public.organizations FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members m
      WHERE m.organization_id = organizations.id AND m.profile_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.organization_join_requests r
      WHERE r.organization_id = organizations.id
        AND r.profile_id = auth.uid()
        AND r.status = 'pending'
    )
  );
DROP POLICY IF EXISTS "create organizations" ON public.organizations;
CREATE POLICY "subscribed create organizations" ON public.organizations FOR INSERT TO authenticated
  WITH CHECK (public.has_active_subscription(auth.uid()));
DROP POLICY IF EXISTS "update organizations" ON public.organizations;
CREATE POLICY "update organizations" ON public.organizations FOR UPDATE TO authenticated
  USING (
    id = public.my_organization_id()
    AND (
      created_by = auth.uid()
      OR public.has_console_permission(auth.uid(), 'organizations.manage')
    )
  );
DROP POLICY IF EXISTS "delete organizations" ON public.organizations;
CREATE POLICY "delete organizations" ON public.organizations FOR DELETE TO authenticated
  USING (created_by = auth.uid() AND id = public.my_organization_id());

-- roles
DROP POLICY IF EXISTS "member read roles" ON public.roles;
DROP POLICY IF EXISTS "authenticated read roles" ON public.roles;
DROP POLICY IF EXISTS "console manage roles" ON public.roles;
DROP POLICY IF EXISTS "console update roles" ON public.roles;
DROP POLICY IF EXISTS "console delete roles" ON public.roles;
DROP POLICY IF EXISTS "linked manage roles" ON public.roles;
DROP POLICY IF EXISTS "linked update roles" ON public.roles;
DROP POLICY IF EXISTS "linked delete roles" ON public.roles;
CREATE POLICY "org read roles" ON public.roles FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid()) AND (
      (
        organization_id = public.my_organization_id()
        AND (
          public.has_console_permission(auth.uid(), 'roles.read')
          OR public.has_console_permission(auth.uid(), 'roles.manage')
          OR public.has_console_permission(auth.uid(), 'users.read')
          OR public.has_console_permission(auth.uid(), 'users.manage')
        )
      )
      OR (
        scope = 'console'
        AND (
          public.has_console_permission(auth.uid(), 'roles.read')
          OR public.has_console_permission(auth.uid(), 'roles.manage')
          OR public.has_console_permission(auth.uid(), 'users.read')
          OR public.has_console_permission(auth.uid(), 'users.manage')
        )
      )
    )
  );
CREATE POLICY "org manage roles" ON public.roles FOR INSERT TO authenticated
  WITH CHECK (
    scope = 'customer'
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'roles.manage')
  );
CREATE POLICY "org update roles" ON public.roles FOR UPDATE TO authenticated
  USING (
    scope = 'customer'
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'roles.manage')
    AND NOT is_system
  );
CREATE POLICY "org delete roles" ON public.roles FOR DELETE TO authenticated
  USING (
    scope = 'customer'
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'roles.manage')
    AND NOT is_system
  );

-- permissions
DROP POLICY IF EXISTS "member read permissions" ON public.permissions;
DROP POLICY IF EXISTS "authenticated read permissions" ON public.permissions;
DROP POLICY IF EXISTS "console manage permissions" ON public.permissions;
DROP POLICY IF EXISTS "console update permissions" ON public.permissions;
DROP POLICY IF EXISTS "console delete permissions" ON public.permissions;
DROP POLICY IF EXISTS "linked manage permissions" ON public.permissions;
DROP POLICY IF EXISTS "linked update permissions" ON public.permissions;
DROP POLICY IF EXISTS "linked delete permissions" ON public.permissions;
DROP POLICY IF EXISTS "insert permissions" ON public.permissions;
DROP POLICY IF EXISTS "update permissions" ON public.permissions;
DROP POLICY IF EXISTS "delete permissions" ON public.permissions;
CREATE POLICY "org read permissions" ON public.permissions FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid()) AND (
      (
        organization_id = public.my_organization_id()
        AND (
          public.has_console_permission(auth.uid(), 'permissions.read')
          OR public.has_console_permission(auth.uid(), 'permissions.manage')
          OR public.has_console_permission(auth.uid(), 'roles.read')
          OR public.has_console_permission(auth.uid(), 'roles.manage')
        )
      )
      OR (
        scope = 'console'
        AND (
          public.has_console_permission(auth.uid(), 'permissions.read')
          OR public.has_console_permission(auth.uid(), 'permissions.manage')
          OR public.has_console_permission(auth.uid(), 'roles.read')
          OR public.has_console_permission(auth.uid(), 'roles.manage')
        )
      )
    )
  );
CREATE POLICY "org manage permissions" ON public.permissions FOR INSERT TO authenticated
  WITH CHECK (
    scope = 'customer'
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'permissions.manage')
  );
CREATE POLICY "org update permissions" ON public.permissions FOR UPDATE TO authenticated
  USING (
    scope = 'customer'
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'permissions.manage')
    AND NOT is_system
  );
CREATE POLICY "org delete permissions" ON public.permissions FOR DELETE TO authenticated
  USING (
    scope = 'customer'
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'permissions.manage')
    AND NOT is_system
  );

-- role_permissions
DROP POLICY IF EXISTS "member read role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "authenticated read role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "console manage role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "console delete role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "linked manage role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "linked delete role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "insert role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "delete role_permissions" ON public.role_permissions;
CREATE POLICY "org read role_permissions" ON public.role_permissions FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid()) AND (
      (
        organization_id = public.my_organization_id()
        AND (
          public.has_console_permission(auth.uid(), 'roles.read')
          OR public.has_console_permission(auth.uid(), 'roles.manage')
        )
      )
      OR (
        organization_id IS NULL
        AND (
          public.has_console_permission(auth.uid(), 'roles.read')
          OR public.has_console_permission(auth.uid(), 'roles.manage')
        )
      )
    )
  );
CREATE POLICY "org manage role_permissions" ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (
    organization_id IS NOT NULL
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'roles.manage')
  );
CREATE POLICY "org delete role_permissions" ON public.role_permissions FOR DELETE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'roles.manage')
  );

-- subjects
DROP POLICY IF EXISTS "member read subjects" ON public.subjects;
DROP POLICY IF EXISTS "linked read subjects" ON public.subjects;
DROP POLICY IF EXISTS "console manage subjects" ON public.subjects;
DROP POLICY IF EXISTS "console update subjects" ON public.subjects;
DROP POLICY IF EXISTS "console delete subjects" ON public.subjects;
DROP POLICY IF EXISTS "linked manage subjects" ON public.subjects;
DROP POLICY IF EXISTS "linked update subjects" ON public.subjects;
DROP POLICY IF EXISTS "linked delete subjects" ON public.subjects;
CREATE POLICY "org read subjects" ON public.subjects FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.read')
      OR public.has_console_permission(auth.uid(), 'users.manage')
    )
  );
CREATE POLICY "org manage subjects" ON public.subjects FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );
CREATE POLICY "org update subjects" ON public.subjects FOR UPDATE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );
CREATE POLICY "org delete subjects" ON public.subjects FOR DELETE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );

-- grants
DROP POLICY IF EXISTS "member read grants" ON public.grants;
DROP POLICY IF EXISTS "linked read grants" ON public.grants;
DROP POLICY IF EXISTS "console manage grants" ON public.grants;
DROP POLICY IF EXISTS "console delete grants" ON public.grants;
DROP POLICY IF EXISTS "linked manage grants" ON public.grants;
DROP POLICY IF EXISTS "linked delete grants" ON public.grants;
CREATE POLICY "org read grants" ON public.grants FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.read')
      OR public.has_console_permission(auth.uid(), 'users.manage')
    )
  );
CREATE POLICY "org manage grants" ON public.grants FOR INSERT TO authenticated
  WITH CHECK (
    organization_id IS NOT NULL
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );
CREATE POLICY "org delete grants" ON public.grants FOR DELETE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );
CREATE POLICY "org update grants" ON public.grants FOR UPDATE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  )
  WITH CHECK (
    organization_id = public.my_organization_id()
  );

-- member_roles (grant rows carry their workspace; members see their own)
DROP POLICY IF EXISTS "member read member_roles" ON public.member_roles;
DROP POLICY IF EXISTS "read member_roles" ON public.member_roles;
DROP POLICY IF EXISTS "manage member_roles" ON public.member_roles;
DROP POLICY IF EXISTS "delete member_roles" ON public.member_roles;
DROP POLICY IF EXISTS "org read member_roles" ON public.member_roles;
DROP POLICY IF EXISTS "org manage member_roles" ON public.member_roles;
DROP POLICY IF EXISTS "org delete member_roles" ON public.member_roles;
CREATE POLICY "org read member_roles" ON public.member_roles FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND member_roles.organization_id = public.my_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = member_roles.profile_id
        AND p.organization_id = public.my_organization_id()
    )
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'members.read')
    )
  );
CREATE POLICY "org manage member_roles" ON public.member_roles FOR INSERT TO authenticated
  WITH CHECK (
    public.has_console_permission(auth.uid(), 'users.manage')
    AND member_roles.organization_id = public.my_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = member_roles.profile_id
        AND p.organization_id = public.my_organization_id()
    )
  );
CREATE POLICY "org delete member_roles" ON public.member_roles FOR DELETE TO authenticated
  USING (
    public.has_console_permission(auth.uid(), 'users.manage')
    AND member_roles.organization_id = public.my_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = member_roles.profile_id
        AND p.organization_id = public.my_organization_id()
    )
  );

-- audit_log
DROP POLICY IF EXISTS "read audit" ON public.audit_log;
CREATE POLICY "org read audit" ON public.audit_log FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'audit.read')
  );
DROP POLICY IF EXISTS "insert audit" ON public.audit_log;
CREATE POLICY "insert audit" ON public.audit_log FOR INSERT TO authenticated
  WITH CHECK (actor_id = auth.uid());

-- join requests
DROP POLICY IF EXISTS "read own or manage requests" ON public.organization_join_requests;
CREATE POLICY "read own or manage requests" ON public.organization_join_requests FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR public.is_org_manager(auth.uid(), organization_id)
  );
DROP POLICY IF EXISTS "request join" ON public.organization_join_requests;
CREATE POLICY "request join" ON public.organization_join_requests FOR INSERT TO authenticated
  WITH CHECK (
    profile_id = auth.uid()
    AND status = 'pending'
  );
DROP POLICY IF EXISTS "withdraw own request" ON public.organization_join_requests;
CREATE POLICY "withdraw own request" ON public.organization_join_requests FOR DELETE TO authenticated
  USING (profile_id = auth.uid() AND status = 'pending');

-- membership edge: read own rows or managed workspaces; writes go through
-- decide_join_request / remove_member / creator trigger only.
DROP POLICY IF EXISTS "read own or manage memberships" ON public.organization_members;
CREATE POLICY "read own or manage memberships" ON public.organization_members FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR public.is_org_manager(auth.uid(), organization_id)
  );

-- api_keys
DROP POLICY IF EXISTS "read api_keys" ON public.api_keys;
DROP POLICY IF EXISTS "manage api_keys" ON public.api_keys;
DROP POLICY IF EXISTS "revoke api_keys" ON public.api_keys;
CREATE POLICY "read api_keys" ON public.api_keys FOR SELECT TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );
CREATE POLICY "manage api_keys" ON public.api_keys FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );
CREATE POLICY "revoke api_keys" ON public.api_keys FOR UPDATE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );

-- billing reads
DROP POLICY IF EXISTS "read active plans" ON public.subscription_plans;
CREATE POLICY "read active plans" ON public.subscription_plans FOR SELECT TO anon, authenticated
  USING (is_active = true);
DROP POLICY IF EXISTS "read own subscription" ON public.user_subscriptions;
CREATE POLICY "read own subscription" ON public.user_subscriptions FOR SELECT TO authenticated
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS "read own billing customer" ON public.billing_customers;
CREATE POLICY "read own billing customer" ON public.billing_customers FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ══════════════════════════════════════════════════════════════════════════
-- §6 VERIFICATION (read the output after running)
-- ══════════════════════════════════════════════════════════════════════════
SELECT 'tables' AS check, tablename AS name FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('profiles', 'organizations', 'roles', 'permissions',
    'role_permissions', 'subjects', 'grants', 'member_roles', 'audit_log',
    'organization_join_requests', 'api_keys', 'subscription_plans',
    'user_subscriptions', 'billing_customers', 'billing_webhook_events')
ORDER BY tablename;

SELECT 'console_permissions' AS check, count(*) AS count FROM public.permissions WHERE scope = 'console';
SELECT 'console_roles' AS check, count(*) AS count FROM public.roles WHERE scope = 'console';
SELECT 'customer_orphans' AS check, count(*) AS count FROM (
  SELECT 1 FROM public.roles WHERE scope = 'customer' AND organization_id IS NULL
  UNION ALL SELECT 1 FROM public.permissions WHERE scope = 'customer' AND organization_id IS NULL
  UNION ALL SELECT 1 FROM public.subjects WHERE organization_id IS NULL
  UNION ALL SELECT 1 FROM public.grants WHERE organization_id IS NULL
  UNION ALL SELECT 1 FROM public.audit_log WHERE organization_id IS NULL
  UNION ALL SELECT 1 FROM public.role_permissions WHERE organization_id IS NULL
    AND EXISTS (SELECT 1 FROM public.roles r WHERE r.id = role_id AND r.scope = 'customer')
) orphan;

SELECT 'functions' AS check, proname AS name FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('my_organization_id', 'is_org_member', 'has_console_permission',
    'my_console_permissions', 'is_org_manager', 'has_role', 'has_permission',
    'has_permission_for_external', 'ensure_subject', 'request_to_join_org',
    'decide_join_request', 'switch_organization', 'remove_member',
    'guard_profile_org_change', 'set_role_permission_org',
    'set_grant_org', 'fill_audit_org', 'grant_creator_membership',
    'handle_new_user', 'sync_subscription',
    'has_active_subscription', '_api_key_id', 'api_key_has_scope', 'api_key_meta', 'api_whoami', 'api_check',
    'api_grant_role', 'api_revoke_grant', 'api_list_roles', 'api_list_permissions',
    'guard_api_key_scopes')
ORDER BY proname;
...[truncated 14068 chars]