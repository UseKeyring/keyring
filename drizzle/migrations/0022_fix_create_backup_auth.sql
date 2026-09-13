-- 0022 FIX CREATE_BACKUP AUTHENTICATION
--
-- Fix the create_backup function to accept user ID as a parameter
-- since auth.uid() doesn't work in RPC calls from edge functions.
--
-- Apply in the Supabase SQL editor.

-- Update the create_backup function to accept user ID explicitly
CREATE OR REPLACE FUNCTION public.create_backup(_organization_id uuid, _user_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _backup_id uuid;
  _storage_path text;
  _is_manager boolean;
  _effective_user_id uuid;
BEGIN
  -- Use the provided user ID, or fall back to auth.uid()
  _effective_user_id := COALESCE(_user_id, auth.uid());
  
  -- Check if user is manager of the organization using the fixed function
  SELECT public.is_org_manager(_effective_user_id, _organization_id) INTO _is_manager;
  
  -- Debug: log the result
  RAISE LOG 'User % checking manager status for org %: %', _effective_user_id, _organization_id, _is_manager;
  
  IF _is_manager IS NULL OR NOT _is_manager THEN
    RAISE EXCEPTION 'Only organization managers can create backups (user: %, org: %, is_manager: %)', 
      _effective_user_id, _organization_id, _is_manager;
  END IF;

  -- Generate storage path
  _storage_path := 'backups/' || _organization_id || '/' || extract(epoch from now()) || '.json';

  -- Create backup record (SECURITY DEFINER bypasses RLS)
  INSERT INTO public.backups (organization_id, storage_path, created_by, status)
  VALUES (_organization_id, _storage_path, _effective_user_id, 'pending')
  RETURNING id INTO _backup_id;

  RETURN _backup_id;
END;
$$;

-- Ensure the function has proper permissions
GRANT EXECUTE ON FUNCTION public.create_backup TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_backup TO service_role;
