-- 0021 FIX CREATE_BACKUP FUNCTION
--
-- Fix the create_backup function to use the simplified manager check
-- and ensure it works with the fixed is_org_manager function.
--
-- Apply in the Supabase SQL editor.

-- Update the create_backup function to be simpler and more reliable
CREATE OR REPLACE FUNCTION public.create_backup(_organization_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _backup_id uuid;
  _storage_path text;
  _is_manager boolean;
BEGIN
  -- Check if user is manager of the organization using the fixed function
  SELECT public.is_org_manager(auth.uid(), _organization_id) INTO _is_manager;
  
  -- Debug: log the result (you can check this in logs)
  RAISE LOG 'User % checking manager status for org %: %', auth.uid(), _organization_id, _is_manager;
  
  IF _is_manager IS NULL OR NOT _is_manager THEN
    RAISE EXCEPTION 'Only organization managers can create backups (user: %, org: %, is_manager: %)', 
      auth.uid(), _organization_id, _is_manager;
  END IF;

  -- Generate storage path
  _storage_path := 'backups/' || _organization_id || '/' || extract(epoch from now()) || '.json';

  -- Create backup record (SECURITY DEFINER bypasses RLS)
  INSERT INTO public.backups (organization_id, storage_path, created_by, status)
  VALUES (_organization_id, _storage_path, auth.uid(), 'pending')
  RETURNING id INTO _backup_id;

  RETURN _backup_id;
END;
$$;

-- Ensure the function has proper permissions
GRANT EXECUTE ON FUNCTION public.create_backup TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_backup TO service_role;
