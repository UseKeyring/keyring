-- 0018 FIX IS_ORG_MANAGER FUNCTION
--
-- Fix the is_org_manager function to properly detect organization owners and managers.
-- The owner (created_by) should always be considered a manager.
--
-- Apply in the Supabase SQL editor.

-- Simplified version that checks if user is org creator OR has management permissions
CREATE OR REPLACE FUNCTION public.is_org_manager(_user_id uuid, _org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- First check if user is the creator (owner)
  SELECT EXISTS (
    SELECT 1 FROM public.organizations 
    WHERE id = _org_id AND created_by = _user_id
  )
  -- OR check if user has management permissions
  OR EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = _user_id AND organization_id = _org_id
  )
  AND EXISTS (
    SELECT 1 FROM public.member_roles mr
    JOIN public.roles r ON r.id = mr.role_id
    JOIN public.role_permissions rp ON rp.role_id = mr.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE mr.profile_id = _user_id
      AND mr.organization_id = _org_id
      AND r.scope = 'console' AND p.scope = 'console'
      AND p.slug IN ('users.manage', 'organizations.manage', 'backups.manage')
  )
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION public.is_org_manager TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_manager TO service_role;
