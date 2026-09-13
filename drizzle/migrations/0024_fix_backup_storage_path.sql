-- 0024 FIX BACKUP STORAGE PATH MISMATCH
--
-- Root cause of "Failed to download backup: {}":
--   create_backup() generated storage_path = 'backups/<org>/<postgres-epoch>.json'
--   but backup-create uploaded to 'backups/<org>/<Date.now()>.json'.
-- Two different filenames -> DB row pointed at a file that was never uploaded,
-- restore downloaded a missing object -> storage 400 + empty error {}.
--
-- Second issue: keys carry a 'backups/' prefix inside the 'backups' bucket
-- (object = backups/backups/<org>/...). Storage policies in 0016 expect
-- foldername(name)[1] = org_id, i.e. key = '<org_id>/file.json'.
-- service_role uploads bypass RLS so it still worked, but the layout is wrong.
--
-- This migration:
--   1. Generates future paths as '<org_id>/<epoch_ms>.json' (no bucket prefix,
--      integer ms to match Date.now() style, no float epoch).
--   2. Extends complete_backup() with an optional _storage_path so the edge
--      function can sync the actual uploaded key back to the DB row.
--      Old 2-arg calls keep working (new param has a DEFAULT).
--
-- Apply in the Supabase SQL editor. Then redeploy edge functions
-- (backup-create / backup-scheduled now upload to the DB-issued path).

-- 1. Future-proof path generation (keep auth logic from 0023, fix path only).
CREATE OR REPLACE FUNCTION public.create_backup(_organization_id uuid, _user_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _backup_id uuid;
  _storage_path text;
  _is_manager boolean;
  _effective_user_id uuid;
  _is_service_role boolean;
BEGIN
  _is_service_role := COALESCE((auth.jwt() ->> 'role') = 'service_role', false);

  -- Anti-spoof: a logged-in caller may not claim to be someone else.
  IF auth.uid() IS NOT NULL AND _user_id IS NOT NULL AND auth.uid() <> _user_id THEN
    RAISE EXCEPTION 'User ID mismatch';
  END IF;

  _effective_user_id := COALESCE(auth.uid(), _user_id);

  -- Scheduled job (service_role, no JWT): attribute to the org creator
  -- and bypass the manager check (there is no user context).
  IF _is_service_role THEN
    IF _effective_user_id IS NULL THEN
      SELECT created_by INTO _effective_user_id
      FROM public.organizations WHERE id = _organization_id;
    END IF;
  ELSE
    -- Authenticated path: require a real JWT. Never trust _user_id alone,
    -- otherwise any caller could impersonate a manager.
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'Not authenticated';
    END IF;
    _effective_user_id := auth.uid();
  END IF;

  IF _effective_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Service-role scheduled backups bypass the manager check (no user context).
  IF NOT _is_service_role THEN
    SELECT public.is_org_manager(_effective_user_id, _organization_id) INTO _is_manager;
    IF _is_manager IS NULL OR NOT _is_manager THEN
      RAISE EXCEPTION 'Only organization managers can create backups (user: %, org: %, is_manager: %)',
        _effective_user_id, _organization_id, _is_manager;
    END IF;
  END IF;

  -- Key INSIDE the 'backups' bucket: '<org_id>/<epoch_ms>.json'.
  -- No 'backups/' prefix (that would nest as backups/backups/...) and integer
  -- millis to match the JS Date.now() style used by edge functions.
  _storage_path := _organization_id::text || '/' || floor(extract(epoch from now()) * 1000)::bigint || '.json';

  INSERT INTO public.backups (organization_id, storage_path, created_by, status)
  VALUES (_organization_id, _storage_path, _effective_user_id, 'pending')
  RETURNING id INTO _backup_id;

  RETURN _backup_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_backup(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_backup(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_backup(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_backup(uuid, uuid) TO service_role;

-- 2. Let the edge function sync the real uploaded key + size on completion.
--    Drops + recreates so the signature change is clean (old 2-arg calls
--    still work because _storage_path has a DEFAULT).
DROP FUNCTION IF EXISTS public.complete_backup(uuid, bigint);
CREATE OR REPLACE FUNCTION public.complete_backup(_backup_id uuid, _size_bytes bigint DEFAULT NULL, _storage_path text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.backups
  SET status = 'completed',
      completed_at = now(),
      size_bytes = COALESCE(_size_bytes, size_bytes),
      storage_path = COALESCE(_storage_path, storage_path)
  WHERE id = _backup_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Backup not found: %', _backup_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_backup(uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_backup(uuid, bigint, text) TO service_role;
-- NOTE: the old (uuid, bigint) overload is re-added by 0025 as a wrapper.
-- Do NOT grant on it here: it does not exist yet at this point, and the
-- GRANT would abort this script before the statements below it run.

-- 3. One-off repair for rows created while DB and edge disagreed.
--    Run the SELECT first to inspect, then the UPDATE for the known-good file.
--    Example for the reported org (replace the filename if yours differs):
--
--    SELECT id, storage_path, status, created_at FROM public.backups
--    WHERE organization_id = '297a9524-dd89-49b5-bdb8-66ca0c061773'
--    ORDER BY created_at DESC LIMIT 10;
--
--    -- Point the pending/completed row at the file that actually exists:
--    -- key inside bucket 'backups' as uploaded by the edge function.
--    UPDATE public.backups
--    SET storage_path = 'backups/297a9524-dd89-49b5-bdb8-66ca0c061773/1789272847563.json'
--    WHERE organization_id = '297a9524-dd89-49b5-bdb8-66ca0c061773'
--      AND storage_path LIKE 'backups/297a9524-dd89-49b5-bdb8-66ca0c061773/%'
--      AND status IN ('pending', 'completed');
