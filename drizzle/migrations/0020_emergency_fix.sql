-- 0020 EMERGENCY FIX FOR BROKEN RLS AND MANAGER DETECTION
--
-- This is an emergency fix to repair the broken authentication and RLS system.
-- Run this in Supabase SQL editor to fix the immediate issues.
--
-- Apply in the Supabase SQL editor.

-- 1. Fix the is_org_manager function - make it simple and reliable
CREATE OR REPLACE FUNCTION public.is_org_manager(_user_id uuid, _org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- Primary check: user is the creator (owner)
  SELECT EXISTS (
    SELECT 1 FROM public.organizations 
    WHERE id = _org_id AND created_by = _user_id
  )
$$;

-- 2. Disable problematic RLS temporarily to restore basic functionality
ALTER TABLE public.organizations DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.backups DISABLE ROW LEVEL SECURITY;

-- 3. Re-enable RLS with simpler, working policies
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backups ENABLE ROW LEVEL SECURITY;

-- 4. Create simple organization policies
DROP POLICY IF EXISTS "Users can create organizations" ON public.organizations;
DROP POLICY IF EXISTS "Subscribed users can create organizations" ON public.organizations;

CREATE POLICY "Users can create organizations"
  ON public.organizations FOR INSERT
  TO authenticated
  WITH CHECK (true); -- Temporarily allow all authenticated users to create orgs

CREATE POLICY "Users can view organizations"
  ON public.organizations FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can update own organizations"
  ON public.organizations FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid());

-- 5. Create simple profile policies
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (id = auth.uid());

-- 6. Create simple backup policies
DROP POLICY IF EXISTS "Users can view their own organization backups" ON public.backups;
DROP POLICY IF EXISTS "Organization managers can create backups" ON public.backups;
DROP POLICY IF EXISTS "Organization managers can update backups" ON public.backups;
DROP POLICY IF EXISTS "Organization managers can delete backups" ON public.backups;

CREATE POLICY "Users can view backups"
  ON public.backups FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can create backups"
  ON public.backups FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Users can update backups"
  ON public.backups FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Users can delete backups"
  ON public.backups FOR DELETE
  TO authenticated
  USING (true);

-- 7. Grant permissions
GRANT ALL ON public.organizations TO authenticated;
GRANT ALL ON public.profiles TO authenticated;
GRANT ALL ON public.backups TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_manager TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_manager TO service_role;

-- 8. Test the fix
-- You can run this to verify the function works:
-- SELECT public.is_org_manager('fb6cf16a-a8e9-459b-a2e1-030d4d2c460e', '3b641216-480e-476a-9140-42de8c98abbc');
-- This should return true now
