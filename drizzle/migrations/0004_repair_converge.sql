-- 0004 REPAIR / CONVERGE
--
-- One-shot repair: brings any database state (0000 only, partial 0002/0003,
-- or anything in between) to the final schema. Every statement is idempotent
-- — safe to run multiple times. Ends with verification queries.
-- Apply in the Supabase SQL editor.

-- ── Tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  avatar_url text,
  website text,
  support_email text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS profiles_organization_id_idx ON public.profiles (organization_id);

CREATE TABLE IF NOT EXISTS public.subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL UNIQUE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, subject_id)
);

CREATE TABLE IF NOT EXISTS public.member_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, role_id)
);

ALTER TABLE public.permissions
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'customer'
  CHECK (scope IN ('customer', 'console'));
ALTER TABLE public.roles
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'customer'
  CHECK (scope IN ('customer', 'console'));

-- Legacy console-tied grants table is replaced by grants + member_roles.
DROP TABLE IF EXISTS public.user_roles;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subjects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.grants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_roles TO authenticated;
GRANT ALL ON public.organizations TO service_role;
GRANT ALL ON public.subjects TO service_role;
GRANT ALL ON public.grants TO service_role;
GRANT ALL ON public.member_roles TO service_role;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_roles ENABLE ROW LEVEL SECURITY;

-- ── Fresh start: remove seed-era RBAC rows (exact slugs only, safe to rerun)
DELETE FROM public.role_permissions
WHERE role_id IN (SELECT id FROM public.roles WHERE slug IN ('admin', 'editor', 'viewer'))
   OR permission_id IN (SELECT id FROM public.permissions WHERE is_system);
DELETE FROM public.permissions WHERE is_system;
DELETE FROM public.roles WHERE slug IN ('admin', 'editor', 'viewer');

-- ── Invisible console plane seed ──────────────────────────────────────────
INSERT INTO public.permissions (slug, name, description, category, is_system, scope) VALUES
  ('users.manage', 'Manage members', 'Grant console roles and remove members.', 'Console', true, 'console'),
  ('roles.manage', 'Manage roles', 'Create, edit and delete customer roles.', 'Console', true, 'console'),
  ('permissions.manage', 'Manage actions', 'Create, edit and delete customer actions.', 'Console', true, 'console'),
  ('organizations.manage', 'Manage organization', 'Edit organization profile and membership.', 'Console', true, 'console'),
  ('audit.read', 'Read audit log', 'View the activity log.', 'Console', true, 'console')
ON CONFLICT (slug) DO UPDATE SET scope = 'console', is_system = true;

INSERT INTO public.roles (slug, name, description, is_system, scope) VALUES
  ('console-manager', 'Manager', 'Full console access. Invisible in customer lists.', true, 'console')
ON CONFLICT (slug) DO UPDATE SET scope = 'console', is_system = true;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.slug = 'console-manager' AND r.scope = 'console' AND p.scope = 'console'
ON CONFLICT DO NOTHING;

-- ── Helpers ───────────────────────────────────────────────────────────────
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

CREATE OR REPLACE FUNCTION public.has_console_permission(_user_id uuid, _perm text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organizations WHERE created_by = _user_id)
  OR EXISTS (
    SELECT 1 FROM public.member_roles mr
    JOIN public.profiles me ON me.id = mr.profile_id
    JOIN public.role_permissions rp ON rp.role_id = mr.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    JOIN public.roles r ON r.id = mr.role_id
    WHERE mr.profile_id = _user_id
      AND me.organization_id IS NOT NULL
      AND r.scope = 'console' AND p.scope = 'console' AND p.slug = _perm
  )
$$;

-- Old check functions are replaced below with new parameter names.
-- CASCADE is safe: every dependent policy is dropped and recreated later
-- in this script.
DROP FUNCTION IF EXISTS public.has_role(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS public.has_permission(uuid, text) CASCADE;

CREATE OR REPLACE FUNCTION public.has_role(_subject_id uuid, _slug text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.grants g
    JOIN public.roles r ON r.id = g.role_id
    WHERE g.subject_id = _subject_id AND r.slug = _slug
  )
$$;

CREATE OR REPLACE FUNCTION public.has_permission(_subject_id uuid, _perm text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.grants g
    JOIN public.role_permissions rp ON rp.role_id = g.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE g.subject_id = _subject_id AND p.slug = _perm
  )
$$;

CREATE OR REPLACE FUNCTION public.has_permission_for_external(_external_id text, _perm text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.grants g
    JOIN public.role_permissions rp ON rp.role_id = g.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    JOIN public.subjects s ON s.id = g.subject_id
    WHERE s.external_id = _external_id AND p.slug = _perm
  )
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

-- ── Policies: drop every historical name, then install the final set ──────
DROP POLICY IF EXISTS "manage roles" ON public.roles;
DROP POLICY IF EXISTS "update roles" ON public.roles;
DROP POLICY IF EXISTS "delete roles" ON public.roles;
DROP POLICY IF EXISTS "linked manage roles" ON public.roles;
DROP POLICY IF EXISTS "linked update roles" ON public.roles;
DROP POLICY IF EXISTS "linked delete roles" ON public.roles;
DROP POLICY IF EXISTS "console manage roles" ON public.roles;
DROP POLICY IF EXISTS "console update roles" ON public.roles;
DROP POLICY IF EXISTS "console delete roles" ON public.roles;

DROP POLICY IF EXISTS "insert permissions" ON public.permissions;
DROP POLICY IF EXISTS "update permissions" ON public.permissions;
DROP POLICY IF EXISTS "delete permissions" ON public.permissions;
DROP POLICY IF EXISTS "linked manage permissions" ON public.permissions;
DROP POLICY IF EXISTS "linked update permissions" ON public.permissions;
DROP POLICY IF EXISTS "linked delete permissions" ON public.permissions;
DROP POLICY IF EXISTS "console manage permissions" ON public.permissions;
DROP POLICY IF EXISTS "console update permissions" ON public.permissions;
DROP POLICY IF EXISTS "console delete permissions" ON public.permissions;

DROP POLICY IF EXISTS "insert role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "delete role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "linked manage role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "linked delete role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "console manage role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "console delete role_permissions" ON public.role_permissions;

DROP POLICY IF EXISTS "linked read subjects" ON public.subjects;
DROP POLICY IF EXISTS "linked manage subjects" ON public.subjects;
DROP POLICY IF EXISTS "linked update subjects" ON public.subjects;
DROP POLICY IF EXISTS "linked delete subjects" ON public.subjects;
DROP POLICY IF EXISTS "console manage subjects" ON public.subjects;
DROP POLICY IF EXISTS "console update subjects" ON public.subjects;
DROP POLICY IF EXISTS "console delete subjects" ON public.subjects;

DROP POLICY IF EXISTS "linked read grants" ON public.grants;
DROP POLICY IF EXISTS "linked manage grants" ON public.grants;
DROP POLICY IF EXISTS "linked delete grants" ON public.grants;
DROP POLICY IF EXISTS "console manage grants" ON public.grants;
DROP POLICY IF EXISTS "console delete grants" ON public.grants;

DROP POLICY IF EXISTS "read member_roles" ON public.member_roles;
DROP POLICY IF EXISTS "manage member_roles" ON public.member_roles;
DROP POLICY IF EXISTS "delete member_roles" ON public.member_roles;

DROP POLICY IF EXISTS "read own profile or with users.read" ON public.profiles;
DROP POLICY IF EXISTS "update own profile" ON public.profiles;
DROP POLICY IF EXISTS "read own or same organization" ON public.profiles;
DROP POLICY IF EXISTS "update own or unlink member" ON public.profiles;
DROP POLICY IF EXISTS "update own or manage member" ON public.profiles;

DROP POLICY IF EXISTS "update organizations" ON public.organizations;
DROP POLICY IF EXISTS "delete organizations" ON public.organizations;

DROP POLICY IF EXISTS "read audit" ON public.audit_log;

DROP POLICY IF EXISTS "authenticated read roles" ON public.roles;
CREATE POLICY "authenticated read roles" ON public.roles FOR SELECT TO authenticated USING (true);
CREATE POLICY "console manage roles" ON public.roles FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'roles.manage'));
CREATE POLICY "console update roles" ON public.roles FOR UPDATE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'roles.manage'));
CREATE POLICY "console delete roles" ON public.roles FOR DELETE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'roles.manage'));

DROP POLICY IF EXISTS "authenticated read permissions" ON public.permissions;
CREATE POLICY "authenticated read permissions" ON public.permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "console manage permissions" ON public.permissions FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'permissions.manage'));
CREATE POLICY "console update permissions" ON public.permissions FOR UPDATE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'permissions.manage'));
CREATE POLICY "console delete permissions" ON public.permissions FOR DELETE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'permissions.manage'));

DROP POLICY IF EXISTS "authenticated read role_permissions" ON public.role_permissions;
CREATE POLICY "authenticated read role_permissions" ON public.role_permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "console manage role_permissions" ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'roles.manage'));
CREATE POLICY "console delete role_permissions" ON public.role_permissions FOR DELETE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'roles.manage'));

CREATE POLICY "linked read subjects" ON public.subjects FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid()));
CREATE POLICY "console manage subjects" ON public.subjects FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'users.manage'));
CREATE POLICY "console update subjects" ON public.subjects FOR UPDATE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'users.manage'));
CREATE POLICY "console delete subjects" ON public.subjects FOR DELETE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'users.manage'));

CREATE POLICY "linked read grants" ON public.grants FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid()));
CREATE POLICY "console manage grants" ON public.grants FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'users.manage'));
CREATE POLICY "console delete grants" ON public.grants FOR DELETE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'users.manage'));

CREATE POLICY "read member_roles" ON public.member_roles FOR SELECT TO authenticated
  USING (public.has_console_permission(auth.uid(), 'users.manage'));
CREATE POLICY "manage member_roles" ON public.member_roles FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'users.manage'));
CREATE POLICY "delete member_roles" ON public.member_roles FOR DELETE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'users.manage'));

DROP POLICY IF EXISTS "insert own profile" ON public.profiles;
CREATE POLICY "insert own profile" ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());
CREATE POLICY "read own or same organization" ON public.profiles FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR (organization_id IS NOT NULL AND organization_id = public.my_organization_id())
  );
CREATE POLICY "update own or manage member" ON public.profiles FOR UPDATE TO authenticated
  USING (
    id = auth.uid()
    OR (organization_id IS NOT NULL AND organization_id = public.my_organization_id()
        AND public.has_console_permission(auth.uid(), 'users.manage'))
  )
  WITH CHECK (id = auth.uid() OR organization_id IS NULL);

DROP POLICY IF EXISTS "authenticated read organizations" ON public.organizations;
CREATE POLICY "authenticated read organizations" ON public.organizations FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "create organizations" ON public.organizations;
CREATE POLICY "create organizations" ON public.organizations FOR INSERT TO authenticated
  WITH CHECK (true);
CREATE POLICY "update organizations" ON public.organizations FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.has_console_permission(auth.uid(), 'organizations.manage'));
CREATE POLICY "delete organizations" ON public.organizations FOR DELETE TO authenticated
  USING (created_by = auth.uid());

CREATE POLICY "read audit" ON public.audit_log FOR SELECT TO authenticated
  USING (public.has_console_permission(auth.uid(), 'audit.read'));
DROP POLICY IF EXISTS "insert audit" ON public.audit_log;
CREATE POLICY "insert audit" ON public.audit_log FOR INSERT TO authenticated
  WITH CHECK (actor_id = auth.uid());

-- ── Verification (read the output after running) ──────────────────────────
SELECT 'tables' AS check, tablename AS name FROM pg_tables
WHERE schemaname = 'public' AND tablename IN ('organizations','subjects','grants','member_roles','user_roles')
ORDER BY tablename;

SELECT 'customer_roles' AS check, count(*) AS count FROM public.roles WHERE scope = 'customer';
SELECT 'customer_permissions' AS check, count(*) AS count FROM public.permissions WHERE scope = 'customer';
SELECT 'console_permissions' AS check, count(*) AS count FROM public.permissions WHERE scope = 'console';

SELECT 'policies_on_permissions' AS check, policyname AS name FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'permissions' ORDER BY policyname;
