-- 0019 FIX RLS POLICIES AND MANAGER FUNCTION
--
-- Fix the broken is_org_manager function and repair organization RLS policies.
-- This addresses the issue where the workspace creator isn't detected as a manager
-- and prevents the "violates row-level security policy" error when creating organizations.
--
-- Apply in the Supabase SQL editor.

-- First, let's fix the is_org_manager function with a simpler, more reliable version
CREATE OR REPLACE FUNCTION public.is_org_manager(_user_id uuid, _org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- Check if user is the creator (owner) - this should be the primary check
  SELECT EXISTS (
    SELECT 1 FROM public.organizations 
    WHERE id = _org_id AND created_by = _user_id
  )
  -- OR check if user has management permissions through member_roles
  OR EXISTS (
    SELECT 1 FROM public.member_roles mr
    JOIN public.roles r ON r.id = mr.role_id  
    JOIN public.role_permissions rp ON rp.role_id = mr.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE mr.profile_id = _user_id
      AND mr.organization_id = _org_id
      AND r.scope = 'console' 
      AND p.scope = 'console'
      AND p.slug IN ('users.manage', 'organizations.manage', 'backups.manage')
  )
$$;

-- Fix the organization RLS policy for INSERT
-- The current policy might be too restrictive
DROP POLICY IF EXISTS "Users can create organizations" ON public.organizations;

CREATE POLICY "Subscribed users can create organizations"
  ON public.organizations FOR INSERT
  TO authenticated
  WITH CHECK (
    -- User must have active Pro or Enterprise subscription
    EXISTS (
      SELECT 1 FROM public.user_subscriptions 
      WHERE user_id = auth.uid() 
        AND plan IN ('pro', 'enterprise') 
        AND status = 'active'
    )
    -- OR user is creating for self-hosted (free tier)
    OR EXISTS (
      SELECT 1 FROM public.user_subscriptions 
      WHERE user_id = auth.uid() 
        AND plan = 'free'
    )
  );

-- Ensure the organization creator can always manage their own organization
DROP POLICY IF EXISTS "Users can update own organizations" ON public.organizations;

CREATE POLICY "Users can update own organizations"
  ON public.organizations FOR UPDATE
  TO authenticated
  USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.member_roles mr
      JOIN public.roles r ON r.id = mr.role_id
      JOIN public.role_permissions rp ON rp.role_id = mr.role_id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE mr.profile_id = auth.uid()
        AND mr.organization_id = public.organizations.id
        AND r.scope = 'console' 
        AND p.scope = 'console'
        AND p.slug = 'organizations.manage'
    )
  );

-- Fix the organization RLS policy for SELECT
DROP POLICY IF EXISTS "Users can view organizations" ON public.organizations;

CREATE POLICY "Users can view organizations"
  ON public.organizations FOR SELECT
  TO authenticated
  USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_members
      WHERE profile_id = auth.uid() AND organization_id = public.organizations.id
    )
  );

-- Grant necessary permissions
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT ALL ON public.organizations TO authenticated;
GRANT ALL ON public.organizations TO service_role;

-- Fix profile RLS to ensure users can update their own organization_id
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Grant execute permissions on the fixed function
GRANT EXECUTE ON FUNCTION public.is_org_manager TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_manager TO service_role;
