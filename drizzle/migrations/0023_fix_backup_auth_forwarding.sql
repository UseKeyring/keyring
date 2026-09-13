-- 0023 FIX BACKUP AUTH (EDGE FUNCTION JWT FORWARDING)
--
-- Root cause: edge functions created the Supabase client with the anon key
-- but never forwarded the caller's JWT, so PostgREST ran RPCs as `anon`
-- and auth.uid() was NULL inside Postgres. The manager check then always
-- failed with "Only organization managers can create backups (user: <NULL>)".
--
-- Fix is two-sided:
--   1. Edge functions must forward `Authorization: Bearer <jwt>` via
--      createClient(url, anonKey, { global: { headers: { Authorization } } })
--      so auth.uid() works again (see supabase/functions/backup-*/index.ts).
--   2. This migration hardens the DB side so both paths work:
--      - authenticated call with forwarded JWT -> auth.uid() is used,
--        an explicit _user_id must match it (anti-spoof).
--      - scheduled job with service_role (no JWT) -> manager check is
--        bypassed, created_by falls back to the org creator.
--
-- Apply in the Supabase SQL editor.

-- 1. Restore a correct is_org_manager (0020 reduced it to creator-only,
--    which breaks non-creator managers; 0018 had an AND/OR precedence bug).
CREATE OR REPLACE FUNCTION public.is_org_manager(_user_id uuid, _org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN _user_id IS NULL OR _org_id IS NULL THEN false ELSE
    EXISTS (
      SELECT 1 FROM public.organizations
      WHERE id = _org_id AND created_by = _user_id
    )
    OR (
      EXISTS (
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
    )
  END
$$;

GRANT EXECUTE ON FUNCTION public.is_org_manager(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_manager(uuid, uuid) TO service_role;

-- 2. create_backup accepts an optional _user_id fallback but prefers auth.uid().
--    Keeps backward compat: old callers passing only _organization_id still work.
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

  _storage_path := 'backups/' || _organization_id || '/' || extract(epoch from now()) || '.json';

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

-- 3. Ensure the remaining backup helpers are executable from edge functions.
GRANT EXECUTE ON FUNCTION public.complete_backup(uuid, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_backup(uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_backup(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_backup(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_old_backups(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_backups(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_organization_backup_data(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_organization_backup_data(uuid) TO service_role;
