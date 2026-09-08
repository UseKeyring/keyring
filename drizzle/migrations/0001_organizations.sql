-- ORGANIZATIONS
-- Each account links to an organization via profiles.organization_id.
-- Apply in the Supabase SQL editor (or: drizzle-kit push with DB_MIGRATION_URL).
CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  avatar_url text,
  website text,
  support_email text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT ALL ON public.organizations TO service_role;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS profiles_organization_id_idx ON public.profiles (organization_id);

-- NOTE: no permissions are seeded. Console access is by organization
-- linkage (see 0002); the RBAC graph itself starts empty.

-- POLICIES
-- Anyone signed in can read organizations (needed for join-by-slug) and
-- create their own. (Update/delete gates are redefined in 0002 around
-- organization linkage.)
CREATE POLICY "authenticated read organizations" ON public.organizations FOR SELECT TO authenticated USING (true);
CREATE POLICY "create organizations" ON public.organizations FOR INSERT TO authenticated
  WITH CHECK (true);
CREATE POLICY "update organizations" ON public.organizations FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.has_permission(auth.uid(), 'organizations.manage'));
CREATE POLICY "delete organizations" ON public.organizations FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'organizations.manage'));
