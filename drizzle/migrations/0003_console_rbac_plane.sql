-- 0003 HIDDEN CONSOLE RBAC PLANE
--
-- The console itself is governed by RBAC rows that must NEVER surface in the
-- customer-facing Actions/Roles lists. A scope column separates the planes:
--   customer = managed in the console UI (roles, actions, subjects, grants)
--   console  = governs the console (invisible in all customer surfaces)
-- Console access is granted via member_roles (profile -> console role).
-- Organization creators implicitly hold every console permission.
-- Apply in the Supabase SQL editor.

-- 1. Scope columns.
ALTER TABLE public.permissions
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'customer'
  CHECK (scope IN ('customer', 'console'));
ALTER TABLE public.roles
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'customer'
  CHECK (scope IN ('customer', 'console'));

-- 2. Seed the invisible console plane (never rendered in customer UI).
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

-- 3. Console grants: workspace account -> console role.
CREATE TABLE public.member_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, role_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_roles TO authenticated;
GRANT ALL ON public.member_roles TO service_role;
ALTER TABLE public.member_roles ENABLE ROW LEVEL SECURITY;

-- 4. Console permission check (creator bypass + console grants).
CREATE OR REPLACE FUNCTION public.am_org_owner()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organizations WHERE created_by = auth.uid())
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

-- 5. Re-gate writes on console permission (creator bypass included).
DROP POLICY IF EXISTS "linked manage roles" ON public.roles;
DROP POLICY IF EXISTS "linked update roles" ON public.roles;
DROP POLICY IF EXISTS "linked delete roles" ON public.roles;
CREATE POLICY "console manage roles" ON public.roles FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'roles.manage'));
CREATE POLICY "console update roles" ON public.roles FOR UPDATE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'roles.manage'));
CREATE POLICY "console delete roles" ON public.roles FOR DELETE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'roles.manage'));

DROP POLICY IF EXISTS "linked manage permissions" ON public.permissions;
DROP POLICY IF EXISTS "linked update permissions" ON public.permissions;
DROP POLICY IF EXISTS "linked delete permissions" ON public.permissions;
CREATE POLICY "console manage permissions" ON public.permissions FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'permissions.manage'));
CREATE POLICY "console update permissions" ON public.permissions FOR UPDATE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'permissions.manage'));
CREATE POLICY "console delete permissions" ON public.permissions FOR DELETE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'permissions.manage'));

DROP POLICY IF EXISTS "linked manage role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "linked delete role_permissions" ON public.role_permissions;
CREATE POLICY "console manage role_permissions" ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'roles.manage'));
CREATE POLICY "console delete role_permissions" ON public.role_permissions FOR DELETE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'roles.manage'));

DROP POLICY IF EXISTS "linked manage subjects" ON public.subjects;
DROP POLICY IF EXISTS "linked update subjects" ON public.subjects;
DROP POLICY IF EXISTS "linked delete subjects" ON public.subjects;
CREATE POLICY "console manage subjects" ON public.subjects FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'users.manage'));
CREATE POLICY "console update subjects" ON public.subjects FOR UPDATE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'users.manage'));
CREATE POLICY "console delete subjects" ON public.subjects FOR DELETE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'users.manage'));

DROP POLICY IF EXISTS "linked manage grants" ON public.grants;
DROP POLICY IF EXISTS "linked delete grants" ON public.grants;
CREATE POLICY "console manage grants" ON public.grants FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'users.manage'));
CREATE POLICY "console delete grants" ON public.grants FOR DELETE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'users.manage'));

DROP POLICY IF EXISTS "update own or unlink member" ON public.profiles;
CREATE POLICY "update own or manage member" ON public.profiles FOR UPDATE TO authenticated
  USING (
    id = auth.uid()
    OR (organization_id IS NOT NULL AND organization_id = public.my_organization_id()
        AND public.has_console_permission(auth.uid(), 'users.manage'))
  )
  WITH CHECK (id = auth.uid() OR organization_id IS NULL);

CREATE POLICY "read member_roles" ON public.member_roles FOR SELECT TO authenticated
  USING (public.has_console_permission(auth.uid(), 'users.manage'));
CREATE POLICY "manage member_roles" ON public.member_roles FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'users.manage'));
CREATE POLICY "delete member_roles" ON public.member_roles FOR DELETE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'users.manage'));

DROP POLICY IF EXISTS "update organizations" ON public.organizations;
CREATE POLICY "update organizations" ON public.organizations FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.has_console_permission(auth.uid(), 'organizations.manage'));

DROP POLICY IF EXISTS "read audit" ON public.audit_log;
CREATE POLICY "read audit" ON public.audit_log FOR SELECT TO authenticated
  USING (public.has_console_permission(auth.uid(), 'audit.read'));
