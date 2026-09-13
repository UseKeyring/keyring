-- 0025 RESTORE complete_backup 2-ARG OVERLOAD
--
-- The first version of 0024 granted on the dropped (uuid, bigint) signature,
-- which aborted the script before the 3-arg grants ran. Depending on where
-- it stopped, the DB may now have the 3-arg function without grants, or
-- neither signature. So this migration is self-contained: it (re)creates
-- the 3-arg function, adds the 2-arg wrapper, and grants both.
--
-- Apply in the Supabase SQL editor AFTER re-applying the fixed 0024.
-- No edge-function redeploy needed.

-- 3-arg version (same as 0024): completes a backup, optionally syncing
-- the real uploaded storage key.
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

-- 2-arg wrapper for pre-0024 callers (incl. the edge-function fallback).
CREATE OR REPLACE FUNCTION public.complete_backup(_backup_id uuid, _size_bytes bigint DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.complete_backup(_backup_id, _size_bytes, NULL::text);
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_backup(uuid, bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_backup(uuid, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_backup(uuid, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_backup(uuid, bigint) TO service_role;
