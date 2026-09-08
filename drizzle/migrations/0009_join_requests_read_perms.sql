-- 0009 JOIN REQUESTS + READ PERMISSIONS
--
-- Two hardening moves:
--
-- 1. Joining an organization requires an approved REQUEST. Anyone could
--    previously self-link by slug (joinOrganization set organization_id
--    directly, and the profiles UPDATE policy even allowed setting your own
--    organization_id to anything). Now membership only changes through the
--    approve function below; a trigger blocks every other path.
--
-- 2. Reads are permission-gated. roles/permissions/role_permissions were
--    world-readable (USING (true)) for any signed-in user, and subjects/
--    grants needed only bare membership. New console read permissions
--    (roles.read, permissions.read, users.read, members.read) gate both the
--    UI and RLS. A `console-viewer` role bundles the reads.
--
-- Every statement is idempotent. Apply in the Supabase SQL editor.

-- ── Read permissions + viewer role ──────────────────────────────────────────
INSERT INTO public.permissions (slug, name, description, category, is_system, scope) VALUES
  ('roles.read', 'View roles', 'See customer roles and the role matrix.', 'Console', true, 'console'),
  ('permissions.read', 'View actions', 'See customer actions.', 'Console', true, 'console'),
  ('users.read', 'View users', 'See subjects and their grants.', 'Console', true, 'console'),
  ('members.read', 'View members', 'See workspace members and join requests.', 'Console', true, 'console')
ON CONFLICT (slug) DO UPDATE SET scope = 'console', is_system = true;

INSERT INTO public.roles (slug, name, description, is_system, scope) VALUES
  ('console-viewer', 'Viewer', 'Read-only console access. Invisible in customer lists.', true, 'console')
ON CONFLICT (slug) DO UPDATE SET scope = 'console', is_system = true;

-- console-manager holds every console permission (covers the new reads);
-- console-viewer holds only the reads.
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.slug = 'console-manager' AND r.scope = 'console' AND p.scope = 'console'
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.slug = 'console-viewer' AND r.scope = 'console'
  AND p.scope = 'console' AND p.slug LIKE '%read'
ON CONFLICT DO NOTHING;

-- ── Own-permission accessor ───────────────────────────────────────────────────
-- The console computes access client-side from roles/role_permissions/
-- permissions — but those tables are read-gated below, which would deadlock
-- discovery (you couldn't learn you hold members.read without already
-- holding a read). This SECURITY DEFINER accessor bypasses RLS and returns
-- only the caller's own console permission slugs.
CREATE OR REPLACE FUNCTION public.my_console_permissions()
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(array_agg(p.slug), '{}')
  FROM public.member_roles mr
  JOIN public.role_permissions rp ON rp.role_id = mr.role_id
  JOIN public.permissions p ON p.id = rp.permission_id
  JOIN public.roles r ON r.id = mr.role_id
  JOIN public.profiles me ON me.id = mr.profile_id
  WHERE mr.profile_id = auth.uid()
    AND me.organization_id IS NOT NULL
    AND r.scope = 'console' AND p.scope = 'console'
$$;

-- ── Org-scoped manager check ────────────────────────────────────────────────
-- Creator of THAT org, or a member of THAT org holding membership-management
-- rights. Unlike has_console_permission (global on purpose for writes), this
-- is scoped so managers of org A can never approve joins into org B.
CREATE OR REPLACE FUNCTION public.is_org_manager(_user_id uuid, _org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organizations WHERE id = _org_id AND created_by = _user_id)
  OR (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = _user_id AND organization_id = _org_id)
    AND (
      public.has_console_permission(_user_id, 'users.manage')
      OR public.has_console_permission(_user_id, 'organizations.manage')
    )
  )
$$;

-- ── Join requests ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.organization_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
-- One pending request per account: no double-requests, no request spam.
CREATE UNIQUE INDEX IF NOT EXISTS join_requests_one_pending_idx
  ON public.organization_join_requests (profile_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS join_requests_org_idx
  ON public.organization_join_requests (organization_id) WHERE status = 'pending';

GRANT SELECT, INSERT, DELETE ON public.organization_join_requests TO authenticated;
GRANT ALL ON public.organization_join_requests TO service_role;
ALTER TABLE public.organization_join_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read own or manage requests" ON public.organization_join_requests;
CREATE POLICY "read own or manage requests" ON public.organization_join_requests FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR public.is_org_manager(auth.uid(), organization_id)
  );
DROP POLICY IF EXISTS "request join" ON public.organization_join_requests;
CREATE POLICY "request join" ON public.organization_join_requests FOR INSERT TO authenticated
  WITH CHECK (
    profile_id = auth.uid()
    AND status = 'pending'
    AND public.my_organization_id() IS NULL
  );
DROP POLICY IF EXISTS "withdraw own request" ON public.organization_join_requests;
CREATE POLICY "withdraw own request" ON public.organization_join_requests FOR DELETE TO authenticated
  USING (profile_id = auth.uid() AND status = 'pending');
-- Decisions go through decide_join_request() only: no client UPDATE policy.

-- File a join request by org slug. Callers already in an org must leave
-- first (profiles hold a single organization_id).
CREATE OR REPLACE FUNCTION public.request_to_join_org(_slug text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org_id uuid;
  _existing uuid;
BEGIN
  SELECT id INTO _org_id FROM public.organizations
  WHERE slug = lower(trim(_slug));
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'No organization found for slug "%"', trim(_slug);
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND organization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'You already belong to an organization';
  END IF;
  SELECT id INTO _existing FROM public.organization_join_requests
  WHERE profile_id = auth.uid() AND status = 'pending';
  IF _existing IS NOT NULL THEN
    RETURN _existing;
  END IF;
  INSERT INTO public.organization_join_requests (organization_id, profile_id)
  VALUES (_org_id, auth.uid())
  RETURNING id INTO _existing;
  RETURN _existing;
END;
$$;

-- Approve or reject a pending request. Links the profile on approval via the
-- org-link bypass flag (see guard below) so the trigger lets it through.
CREATE OR REPLACE FUNCTION public.decide_join_request(_request_id uuid, _approve boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _org_id uuid;
  _profile_id uuid;
  _status text;
BEGIN
  SELECT organization_id, profile_id, status
    INTO _org_id, _profile_id, _status
  FROM public.organization_join_requests WHERE id = _request_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
  IF _status <> 'pending' THEN
    RAISE EXCEPTION 'Request already decided';
  END IF;
  IF NOT public.is_org_manager(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Only workspace managers can decide join requests';
  END IF;
  IF _approve THEN
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id = _profile_id AND organization_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Requester already belongs to an organization';
    END IF;
    PERFORM set_config('app.org_link_bypass', 'on', true);
    UPDATE public.profiles SET organization_id = _org_id WHERE id = _profile_id;
  END IF;
  UPDATE public.organization_join_requests
  SET status = CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,
      decided_at = now(),
      decided_by = auth.uid()
  WHERE id = _request_id;
END;
$$;

-- ── Org-link guard ──────────────────────────────────────────────────────────
-- organization_id is the membership edge: without this trigger any user
-- could bypass the request flow with a direct profiles UPDATE (the UPDATE
-- policy allows editing your own row). Allowed paths: leaving yourself,
-- linking yourself as creator of the target org (create-workspace flow),
-- a manager unlinking a member of their org (remove flow), and the approve
-- function above (bypass flag, transaction-local).
CREATE OR REPLACE FUNCTION public.guard_profile_org_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.org_link_bypass', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS NULL AND OLD.id = auth.uid() THEN
    RETURN NEW;
  END IF;
  IF OLD.id = auth.uid() AND NEW.organization_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.organizations
                 WHERE id = NEW.organization_id AND created_by = auth.uid()) THEN
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS NULL AND OLD.organization_id IS NOT NULL
     AND public.is_org_manager(auth.uid(), OLD.organization_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Organization membership can only change via join approval';
END;
$$;

DROP TRIGGER IF EXISTS guard_profile_org_change ON public.profiles;
CREATE TRIGGER guard_profile_org_change
  BEFORE UPDATE OF organization_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_org_change();

-- ── Tightened read policies ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "authenticated read roles" ON public.roles;
-- Role definitions are workspace vocabulary: the Users page needs role
-- headers (users.read) and role viewers need the list itself (roles.read).
CREATE POLICY "member read roles" ON public.roles FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND (
      public.has_console_permission(auth.uid(), 'roles.read')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
      OR public.has_console_permission(auth.uid(), 'users.read')
      OR public.has_console_permission(auth.uid(), 'users.manage')
    )
  );

DROP POLICY IF EXISTS "authenticated read permissions" ON public.permissions;
-- Action definitions likewise: the Roles page and matrix need action names
-- (roles.read) alongside the Actions page itself (permissions.read).
CREATE POLICY "member read permissions" ON public.permissions FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND (
      public.has_console_permission(auth.uid(), 'permissions.read')
      OR public.has_console_permission(auth.uid(), 'permissions.manage')
      OR public.has_console_permission(auth.uid(), 'roles.read')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );

DROP POLICY IF EXISTS "authenticated read role_permissions" ON public.role_permissions;
CREATE POLICY "member read role_permissions" ON public.role_permissions FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND (
      public.has_console_permission(auth.uid(), 'roles.read')
      OR public.has_console_permission(auth.uid(), 'roles.manage')
    )
  );

DROP POLICY IF EXISTS "linked read subjects" ON public.subjects;
CREATE POLICY "member read subjects" ON public.subjects FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND (
      public.has_console_permission(auth.uid(), 'users.read')
      OR public.has_console_permission(auth.uid(), 'users.manage')
    )
  );

DROP POLICY IF EXISTS "linked read grants" ON public.grants;
CREATE POLICY "member read grants" ON public.grants FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND (
      public.has_console_permission(auth.uid(), 'users.read')
      OR public.has_console_permission(auth.uid(), 'users.manage')
    )
  );

DROP POLICY IF EXISTS "read member_roles" ON public.member_roles;
CREATE POLICY "member read member_roles" ON public.member_roles FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'members.read')
    )
  );

DROP POLICY IF EXISTS "read own or same organization" ON public.profiles;
CREATE POLICY "read own or same organization" ON public.profiles FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR (
      organization_id IS NOT NULL
      AND organization_id = public.my_organization_id()
      AND (
        public.is_org_manager(auth.uid(), organization_id)
        OR public.has_console_permission(auth.uid(), 'members.read')
        OR public.has_console_permission(auth.uid(), 'users.manage')
      )
    )
    -- Managers deciding requests need the requester's identity.
    OR EXISTS (
      SELECT 1 FROM public.organization_join_requests r
      WHERE r.profile_id = public.profiles.id
        AND r.status = 'pending'
        AND r.organization_id = public.my_organization_id()
        AND public.is_org_manager(auth.uid(), r.organization_id)
    )
  );

-- ── Verification (read the output after running) ────────────────────────────
SELECT 'console_permissions' AS check, slug AS name FROM public.permissions
WHERE scope = 'console' ORDER BY slug;

SELECT 'console_roles' AS check, slug AS name FROM public.roles
WHERE scope = 'console' ORDER BY slug;

SELECT 'policies' AS check, tablename || '.' || policyname AS name FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('roles', 'permissions', 'role_permissions', 'subjects', 'grants', 'member_roles', 'profiles', 'organization_join_requests')
  AND cmd = 'SELECT'
ORDER BY tablename, policyname;

SELECT 'functions' AS check, proname AS name FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('my_console_permissions', 'is_org_manager', 'request_to_join_org', 'decide_join_request', 'guard_profile_org_change')
ORDER BY proname;
