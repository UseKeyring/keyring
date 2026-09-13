-- 0017 FIX BACKUP FUNCTIONS
--
-- Fix the create_backup function to properly handle RLS and manager checks.
-- Apply in the Supabase SQL editor.

-- Update the create_backup function to bypass RLS for the insert
CREATE OR REPLACE FUNCTION public.create_backup(_organization_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _backup_id uuid;
  _storage_path text;
  _is_manager boolean;
BEGIN
  -- Check if user is manager of the organization
  SELECT public.is_org_manager(auth.uid(), _organization_id) INTO _is_manager;
  
  IF _is_manager IS NULL OR NOT _is_manager THEN
    RAISE EXCEPTION 'Only organization managers can create backups';
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

-- Update complete_backup to handle cases where backup might not exist
CREATE OR REPLACE FUNCTION public.complete_backup(_backup_id uuid, _size_bytes bigint DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.backups
  SET status = 'completed',
      completed_at = now(),
      size_bytes = _size_bytes
  WHERE id = _backup_id;
  
  -- If no rows were updated, the backup doesn't exist
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backup not found: %', _backup_id;
  END IF;
END;
$$;

-- Update fail_backup to handle cases where backup might not exist
CREATE OR REPLACE FUNCTION public.fail_backup(_backup_id uuid, _error_message text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.backups
  SET status = 'failed',
      completed_at = now(),
      error_message = _error_message
  WHERE id = _backup_id;
  
  -- If no rows were updated, the backup doesn't exist
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backup not found: %', _backup_id;
  END IF;
END;
$$;

-- Ensure the cleanup function also works properly
CREATE OR REPLACE FUNCTION public.cleanup_old_backups(_organization_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Delete backups older than 7 days
  DELETE FROM public.backups
  WHERE organization_id = _organization_id
    AND created_at < now() - interval '7 days'
    AND status = 'completed';
END;
$$;
