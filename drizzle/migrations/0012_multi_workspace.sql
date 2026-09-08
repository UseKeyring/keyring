-- 0012 MULTI-WORKSPACE MEMBERSHIPS
--
-- Accounts can now belong to many workspaces (URLs carry the workspace slug:
-- /dashboard/[orgSlug]/…). profiles.organization_id remains as the ACTIVE
-- workspace, so every 0011 policy keeps working unchanged — it now simply
-- scopes to whichever workspace is active.
--
-- What changes:
--   organization_members: the membership edge (profile ↔ workspace).
--     Switching workspaces = changing the active edge (switch_organization).
--   member_roles.organization_id: console grants apply in ONE workspace.
--     has_console_permission + my_console_permissions + is_org_manager are
--     rewritten around the active workspace / an explicit org, closing the
--     hole where a creator-or-manager of workspace A held powers in B.
--   Join requests no longer require being org-less; approval adds the
--     membership edge and activates the workspace. Pending uniqueness is
--     per (workspace, account) instead of per account.
--   remove_member(): manager-or-self removal that deletes the edge, revokes
--     that workspace's console grants, and repairs the active workspace.
--     Owners cannot be removed.
--   organizations SELECT opens to workspaces you belong to (the switcher and
--     URL resolution need it); slug lookup for requests still runs inside
--     request_to_join_org (SECURITY DEFINER).
--
-- Every statement is idempotent. Apply in the Supabase SQL editor.

-- ── Membership edge ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, organization_id)
);
CREATE INDEX IF NOT EXISTS organization_members_org_idx
  ON public.organization_members (organization_id);
CREATE INDEX IF NOT EXISTS organization_members_profile_idx
  ON public.organization_members (profile_id);

GRANT SELECT ON public.organization_members TO authenticated;
GRANT ALL ON public.organization_members TO service_role;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

-- Creators are members of what they create: without this edge the new
-- workspace would be invisible (organizations SELECT is membership-based)
-- and un-rejoinable after switching away.
CREATE OR REPLACE FUNCTION public.grant_creator_membership()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.created_by IS NOT NULL THEN
    INSERT INTO public.organization_members (organization_id, profile_id)
    VALUES (NEW.id, NEW.created_by)
    ON CONFLICT (profile_id, organization_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS grant_creator_membership ON public.organizations;
CREATE TRIGGER grant_creator_membership
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.grant_creator_membership();

-- Backfill from the single-org edge. No client writes this table directly:
-- membership is granted only through decide_join_request().
INSERT INTO public.organization_members (organization_id, profile_id)
SELECT organization_id, id FROM public.profiles
WHERE organization_id IS NOT NULL
ON CONFLICT (profile_id, organization_id) DO NOTHING;

DROP POLICY IF EXISTS "read own or manage memberships" ON public.organization_members;
CREATE POLICY "read own or manage memberships" ON public.organization_members FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR public.is_org_manager(auth.uid(), organization_id)
  );

-- ── Console grants apply in one workspace ───────────────────────────────────
ALTER TABLE public.member_roles ADD COLUMN IF NOT EXISTS organization_id uuid
  REFERENCES public.organizations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS member_roles_organization_id_idx
  ON public.member_roles (organization_id);

UPDATE public.member_roles mr SET organization_id = (
  SELECT organization_id FROM public.profiles WHERE id = mr.profile_id
) WHERE mr.organization_id IS NULL;
-- Grants held by workspace-less accounts stay NULL and match nothing below
-- (fail closed) until re-granted inside a workspace.

-- Creator bypass now means creator of the ACTIVE workspace (was: creator of
-- any workspace), and grants only count in the workspace they were made in.
CREATE OR REPLACE FUNCTION public.has_console_permission(_user_id uuid, _perm text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organizations o
    JOIN public.profiles me ON me.id = _user_id
    WHERE o.created_by = _user_id AND o.id = me.organization_id
  )
  OR EXISTS (
    SELECT 1 FROM public.member_roles mr
    JOIN public.profiles me ON me.id = mr.profile_id
    JOIN public.role_permissions rp ON rp.role_id = mr.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    JOIN public.roles r ON r.id = mr.role_id
    WHERE mr.profile_id = _user_id
      AND me.organization_id IS NOT NULL
      AND mr.organization_id = me.organization_id
      AND r.scope = 'console' AND p.scope = 'console' AND p.slug = _perm
  )
$$;

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
    AND mr.organization_id = me.organization_id
    AND r.scope = 'console' AND p.scope = 'console'
$$;

-- is_org_manager checks grants in THAT workspace, not the active one (it is
-- called for workspaces other than the active one, e.g. join approvals).
CREATE OR REPLACE FUNCTION public.is_org_manager(_user_id uuid, _org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organizations WHERE id = _org_id AND created_by = _user_id)
  OR (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = _user_id AND organization_id = _org_id)
    AND EXISTS (
      SELECT 1 FROM public.member_roles mr
      JOIN public.role_permissions rp ON rp.role_id = mr.role_id
      JOIN public.permissions p ON p.id = rp.permission_id
      JOIN public.roles r ON r.id = mr.role_id
      WHERE mr.profile_id = _user_id
        AND mr.organization_id = _org_id
        AND r.scope = 'console' AND p.scope = 'console'
        AND p.slug IN ('users.manage', 'organizations.manage')
    )
  )
$$;

-- member_roles rows are now workspace-owned: same capability as before,
-- pinned to the caller's workspace.
DROP POLICY IF EXISTS "org read member_roles" ON public.member_roles;
DROP POLICY IF EXISTS "org manage member_roles" ON public.member_roles;
DROP POLICY IF EXISTS "org delete member_roles" ON public.member_roles;
CREATE POLICY "org read member_roles" ON public.member_roles FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND member_roles.organization_id = public.my_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = member_roles.profile_id
        AND p.organization_id = public.my_organization_id()
    )
    AND (
      public.has_console_permission(auth.uid(), 'users.manage')
      OR public.has_console_permission(auth.uid(), 'members.read')
    )
  );
CREATE POLICY "org manage member_roles" ON public.member_roles FOR INSERT TO authenticated
  WITH CHECK (
    public.has_console_permission(auth.uid(), 'users.manage')
    AND member_roles.organization_id = public.my_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = member_roles.profile_id
        AND p.organization_id = public.my_organization_id()
    )
  );
CREATE POLICY "org delete member_roles" ON public.member_roles FOR DELETE TO authenticated
  USING (
    public.has_console_permission(auth.uid(), 'users.manage')
    AND member_roles.organization_id = public.my_organization_id()
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = member_roles.profile_id
        AND p.organization_id = public.my_organization_id()
    )
  );

-- ── Join flow goes multi-workspace ──────────────────────────────────────────
-- Pending uniqueness becomes per (workspace, account): one open request per
-- workspace instead of one globally. Safe: the old index allowed at most one
-- pending row per account, so no duplicates can exist.
DROP INDEX IF EXISTS join_requests_one_pending_idx;
CREATE UNIQUE INDEX IF NOT EXISTS join_requests_one_pending_idx
  ON public.organization_join_requests (organization_id, profile_id) WHERE status = 'pending';

-- Members of other workspaces may request in: the org-less requirement is
-- gone. Approval adds the edge and activates the workspace.
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
  IF EXISTS (SELECT 1 FROM public.organization_members
             WHERE profile_id = auth.uid() AND organization_id = _org_id) THEN
    RAISE EXCEPTION 'You already belong to this workspace';
  END IF;
  SELECT id INTO _existing FROM public.organization_join_requests
  WHERE profile_id = auth.uid() AND organization_id = _org_id AND status = 'pending';
  IF _existing IS NOT NULL THEN
    RETURN _existing;
  END IF;
  INSERT INTO public.organization_join_requests (organization_id, profile_id)
  VALUES (_org_id, auth.uid())
  RETURNING id INTO _existing;
  RETURN _existing;
END;
$$;

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
    INSERT INTO public.organization_members (organization_id, profile_id)
    VALUES (_org_id, _profile_id)
    ON CONFLICT (profile_id, organization_id) DO NOTHING;
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

-- Members of other workspaces may request in: the org-less requirement is
-- gone (per-workspace duplicates are stopped by the unique index + the
-- function's own pending check).
DROP POLICY IF EXISTS "request join" ON public.organization_join_requests;
CREATE POLICY "request join" ON public.organization_join_requests FOR INSERT TO authenticated
  WITH CHECK (
    profile_id = auth.uid()
    AND status = 'pending'
  );

-- Activate one of my workspaces (drives the URL slug). The guard trigger
-- would block a direct self-update, hence the bypass flag.
CREATE OR REPLACE FUNCTION public.switch_organization(_organization_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE profile_id = auth.uid() AND organization_id = _organization_id
  ) THEN
    RAISE EXCEPTION 'Not a member of this workspace';
  END IF;
  PERFORM set_config('app.org_link_bypass', 'on', true);
  UPDATE public.profiles SET organization_id = _organization_id WHERE id = auth.uid();
END;
$$;

-- Manager-or-self removal: drops the edge, revokes that workspace's console
-- grants, and repairs the active workspace (another membership, else NULL).
-- Owners cannot be removed.
CREATE OR REPLACE FUNCTION public.remove_member(_profile_id uuid, _organization_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (
    public.is_org_manager(auth.uid(), _organization_id) OR auth.uid() = _profile_id
  ) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = _organization_id AND created_by = _profile_id
  ) THEN
    RAISE EXCEPTION 'Cannot remove the workspace owner';
  END IF;
  DELETE FROM public.member_roles
  WHERE profile_id = _profile_id AND organization_id = _organization_id;
  DELETE FROM public.organization_members
  WHERE profile_id = _profile_id AND organization_id = _organization_id;
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = _profile_id AND organization_id = _organization_id
  ) THEN
    PERFORM set_config('app.org_link_bypass', 'on', true);
    UPDATE public.profiles SET organization_id = (
      SELECT organization_id FROM public.organization_members
      WHERE profile_id = _profile_id ORDER BY created_at LIMIT 1
    ) WHERE id = _profile_id;
  END IF;
END;
$$;

-- "account" would shadow the /dashboard/account route (static beats
-- [orgSlug]); reserve it at the database level.
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_slug_reserved_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_slug_reserved_check CHECK (
  slug NOT IN ('account')
);

-- Workspaces you belong to are readable (switcher + slug resolution). Slug
-- lookup for requests still runs inside request_to_join_org.
DROP POLICY IF EXISTS "org read organizations" ON public.organizations;
CREATE POLICY "org read organizations" ON public.organizations FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members m
      WHERE m.organization_id = organizations.id AND m.profile_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.organization_join_requests r
      WHERE r.organization_id = organizations.id
        AND r.profile_id = auth.uid()
        AND r.status = 'pending'
    )
  );

-- ── Verification (read the output after running) ────────────────────────────
SELECT 'member_edges' AS check, count(*) AS count FROM public.organization_members;
SELECT 'members_without_edge' AS check, count(*) AS count FROM public.profiles p
WHERE p.organization_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.organization_members m
                  WHERE m.profile_id = p.id AND m.organization_id = p.organization_id);
SELECT 'grants_missing_org' AS check, count(*) AS count FROM public.member_roles
WHERE organization_id IS NULL
  AND EXISTS (SELECT 1 FROM public.profiles p
              WHERE p.id = member_roles.profile_id AND p.organization_id IS NOT NULL);
SELECT 'policies_on_member_roles' AS check, policyname AS name FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'member_roles' ORDER BY policyname;
SELECT 'functions' AS check, proname AS name FROM pg_proc
WHERE pronamespace = 'public'::regnamespace
  AND proname IN ('switch_organization', 'remove_member', 'is_org_manager',
    'has_console_permission', 'my_console_permissions', 'grant_creator_membership')
ORDER BY proname;
