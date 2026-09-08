-- 0002 DECOUPLE CONSOLE ACCOUNTS FROM RBAC
--
-- Console accounts (auth.users / profiles) operate the workspace. They are
-- NOT part of the RBAC graph. Access checks run against external subjects
-- (end-users of the customer's product, keyed by external_id), and any
-- organization-linked account may manage RBAC data.
--
-- This migration also wipes seed-era RBAC data: fresh start, no roles,
-- no actions, no grants.
-- Apply in the Supabase SQL editor (or: drizzle-kit push with DB_MIGRATION_URL).

-- 1. Fresh start: wipe seed-era RBAC data (children first).
DELETE FROM public.role_permissions;
DELETE FROM public.user_roles;
DELETE FROM public.permissions;
DELETE FROM public.roles;

-- 2. Console-access helpers.
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

-- 3. Subjects: external end-users. Grants replace user_roles.
CREATE TABLE public.subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id text NOT NULL UNIQUE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subjects TO authenticated;
GRANT ALL ON public.subjects TO service_role;
ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  subject_id uuid NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, subject_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.grants TO authenticated;
GRANT ALL ON public.grants TO service_role;
ALTER TABLE public.grants ENABLE ROW LEVEL SECURITY;

DROP TABLE public.user_roles;

-- 4. Drop permission-gated policies (the permissions they checked are gone;
-- gates move to organization linkage).
DROP POLICY IF EXISTS "manage roles" ON public.roles;
DROP POLICY IF EXISTS "update roles" ON public.roles;
DROP POLICY IF EXISTS "delete roles" ON public.roles;
DROP POLICY IF EXISTS "insert permissions" ON public.permissions;
DROP POLICY IF EXISTS "update permissions" ON public.permissions;
DROP POLICY IF EXISTS "delete permissions" ON public.permissions;
DROP POLICY IF EXISTS "insert role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "delete role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "read own profile or with users.read" ON public.profiles;
DROP POLICY IF EXISTS "update organizations" ON public.organizations;
DROP POLICY IF EXISTS "delete organizations" ON public.organizations;

-- 5. Linked-member management policies.
CREATE POLICY "linked manage roles" ON public.roles FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid()));
CREATE POLICY "linked update roles" ON public.roles FOR UPDATE TO authenticated
  USING (public.is_org_member(auth.uid()));
CREATE POLICY "linked delete roles" ON public.roles FOR DELETE TO authenticated
  USING (public.is_org_member(auth.uid()));

CREATE POLICY "linked manage permissions" ON public.permissions FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid()));
CREATE POLICY "linked update permissions" ON public.permissions FOR UPDATE TO authenticated
  USING (public.is_org_member(auth.uid()));
CREATE POLICY "linked delete permissions" ON public.permissions FOR DELETE TO authenticated
  USING (public.is_org_member(auth.uid()));

CREATE POLICY "linked manage role_permissions" ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid()));
CREATE POLICY "linked delete role_permissions" ON public.role_permissions FOR DELETE TO authenticated
  USING (public.is_org_member(auth.uid()));

CREATE POLICY "linked read subjects" ON public.subjects FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid()));
CREATE POLICY "linked manage subjects" ON public.subjects FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid()));
CREATE POLICY "linked update subjects" ON public.subjects FOR UPDATE TO authenticated
  USING (public.is_org_member(auth.uid()));
CREATE POLICY "linked delete subjects" ON public.subjects FOR DELETE TO authenticated
  USING (public.is_org_member(auth.uid()));

CREATE POLICY "linked read grants" ON public.grants FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid()));
CREATE POLICY "linked manage grants" ON public.grants FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid()));
CREATE POLICY "linked delete grants" ON public.grants FOR DELETE TO authenticated
  USING (public.is_org_member(auth.uid()));

-- Profiles: own row plus anyone in the same organization.
CREATE POLICY "read own or same organization" ON public.profiles FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR (organization_id IS NOT NULL AND organization_id = public.my_organization_id())
  );

-- Profiles update: own row freely, or unlink a same-org member (set NULL only).
DROP POLICY IF EXISTS "update own profile" ON public.profiles;
CREATE POLICY "update own or unlink member" ON public.profiles FOR UPDATE TO authenticated
  USING (
    id = auth.uid()
    OR (organization_id IS NOT NULL AND organization_id = public.my_organization_id())
  )
  WITH CHECK (id = auth.uid() OR organization_id IS NULL);

-- Organizations: creator or any linked member may edit.
CREATE POLICY "update organizations" ON public.organizations FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.is_org_member(auth.uid()));
CREATE POLICY "delete organizations" ON public.organizations FOR DELETE TO authenticated
  USING (created_by = auth.uid());

-- 6. Subject-based check functions (no system roles anymore).
-- DROP first: OR REPLACE cannot rename parameters, and old policies
-- referencing these are all dropped and recreated below.
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

-- 7. New-user handler: profile row only. Console accounts are operators,
-- never RBAC subjects — no role assignment.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, COALESCE(NEW.email, ''), NEW.raw_user_meta_data ->> 'full_name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
