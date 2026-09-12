-- 0011 WORKSPACE ISOLATION
--
-- Every customer-plane row is now owned by exactly one workspace. Before
-- this migration, roles/permissions/subjects/grants/member_roles/audit_log
-- were global tables: any member of any workspace could read (and, with a
-- console grant, mutate) every other workspace's data.
--
-- Model after this migration:
--   roles / permissions : organization_id NULL ⟺ scope='console' (global
--     system plane: console-manager, users.manage, …); NOT NULL ⟺ customer.
--   role_permissions / subjects / grants / audit_log : organization_id
--     NOT NULL, always. Cross-workspace links are rejected by triggers.
--   member_roles : no column (links a profile to a global console role);
--     policies scope it through the member profile's organization instead.
--   Slugs/external_ids are unique PER workspace, not globally.
--
-- Backfill: existing customer rows cannot be attributed — the old schema
-- stored no link. They are all assigned to the earliest-created
-- organization (NOTICEd at runtime with counts). If that is wrong, move
-- rows between workspaces with plain UPDATEs before tightening further.
-- Console-scope rows stay global (NULL) by design.
--
-- API functions (0007) and ensure_subject (0005) are rewritten to scope
-- every lookup by the calling key's organization_id.
--
-- Every statement is idempotent. Apply in the Supabase SQL editor.

-- ── Columns ─────────────────────────────────────────────────────────────────
ALTER TABLE public.roles ADD COLUMN IF NOT EXISTS organization_id uuid
  REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE public.permissions ADD COLUMN IF NOT EXISTS organization_id uuid
  REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE public.role_permissions ADD COLUMN IF NOT EXISTS organization_id uuid
  REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE public.subjects ADD COLUMN IF NOT EXISTS organization_id uuid
  REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE public.grants ADD COLUMN IF NOT EXISTS organization_id uuid
  REFERENCES public.organizations(id) ON DELETE CASCADE;
ALTER TABLE public.audit_log ADD COLUMN IF NOT EXISTS organization_id uuid
  REFERENCES public.organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS roles_organization_id_idx ON public.roles (organization_id);
CREATE INDEX IF NOT EXISTS permissions_organization_id_idx ON public.permissions (organization_id);
CREATE INDEX IF NOT EXISTS role_permissions_organization_id_idx ON public.role_permissions (organization_id);
CREATE INDEX IF NOT EXISTS subjects_organization_id_idx ON public.subjects (organization_id);
CREATE INDEX IF NOT EXISTS grants_organization_id_idx ON public.grants (organization_id);
CREATE INDEX IF NOT EXISTS audit_log_organization_id_idx ON public.audit_log (organization_id);

-- Console plane is global (NULL org), customer plane is owned (NOT NULL).
-- Added AFTER the backfill below: existing customer rows start NULL.
ALTER TABLE public.roles DROP CONSTRAINT IF EXISTS roles_scope_org_check;
ALTER TABLE public.permissions DROP CONSTRAINT IF EXISTS permissions_scope_org_check;

-- ── Per-workspace uniqueness (was global) ────────────────────────────────────
ALTER TABLE public.roles DROP CONSTRAINT IF EXISTS roles_slug_key;
ALTER TABLE public.permissions DROP CONSTRAINT IF EXISTS permissions_slug_key;
ALTER TABLE public.subjects DROP CONSTRAINT IF EXISTS subjects_external_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS roles_slug_global_uniq
  ON public.roles (slug) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS roles_slug_org_uniq
  ON public.roles (organization_id, slug) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS permissions_slug_global_uniq
  ON public.permissions (slug) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS permissions_slug_org_uniq
  ON public.permissions (organization_id, slug) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subjects_external_org_uniq
  ON public.subjects (organization_id, external_id);

-- Re-seed console plane (arbiter-free DO NOTHING: live DBs already have them).
INSERT INTO public.permissions (slug, name, description, category, is_system, scope) VALUES
  ('users.manage', 'Manage members', 'Grant console roles and remove members.', 'Console', true, 'console'),
  ('roles.manage', 'Manage roles', 'Create, edit and delete customer roles.', 'Console', true, 'console'),
  ('permissions.manage', 'Manage actions', 'Create, edit and delete customer actions.', 'Console', true, 'console'),
  ('organizations.manage', 'Manage organization', 'Edit organization profile and membership.', 'Console', true, 'console'),
  ('audit.read', 'Read audit log', 'View the activity log.', 'Console', true, 'console'),
  ('roles.read', 'View roles', 'See customer roles and the role matrix.', 'Console', true, 'console'),
  ('permissions.read', 'View actions', 'See customer actions.', 'Console', true, 'console'),
  ('users.read', 'View users', 'See subjects and their grants.', 'Console', true, 'console'),
  ('members.read', 'View members', 'See workspace members and join requests.', 'Console', true, 'console')
ON CONFLICT DO NOTHING;
INSERT INTO public.roles (slug, name, description, is_system, scope) VALUES
  ('console-manager', 'Manager', 'Full console access. Invisible in customer lists.', true, 'console'),
  ('console-viewer', 'Viewer', 'Read-only console access. Invisible in customer lists.', true, 'console')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.slug = 'console-manager' AND r.scope = 'console' AND p.scope = 'console'
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.slug = 'console-viewer' AND r.scope = 'console'
  AND p.scope = 'console' AND p.slug LIKE '%read'
ON CONFLICT DO NOTHING;

-- ── Backfill: attribute orphans to the earliest workspace ────────────────────
DO $$
DECLARE
  _org uuid;
  _org_count int;
  _n_roles int;
  _n_perms int;
  _n_subjects int;
BEGIN
  SELECT count(*) INTO _org_count FROM public.organizations;
  SELECT id INTO _org FROM public.organizations ORDER BY created_at ASC LIMIT 1;

  SELECT count(*) INTO _n_roles FROM public.roles WHERE scope = 'customer' AND organization_id IS NULL;
  SELECT count(*) INTO _n_perms FROM public.permissions WHERE scope = 'customer' AND organization_id IS NULL;
  SELECT count(*) INTO _n_subjects FROM public.subjects WHERE organization_id IS NULL;

  IF _n_roles + _n_perms + _n_subjects > 0 AND _org IS NULL THEN
    RAISE EXCEPTION 'Cannot isolate: % roles, % permissions, % subjects exist but no organization found',
      _n_roles, _n_perms, _n_subjects;
  END IF;

  IF _org IS NOT NULL THEN
    UPDATE public.roles SET organization_id = _org
    WHERE scope = 'customer' AND organization_id IS NULL;
    UPDATE public.permissions SET organization_id = _org
    WHERE scope = 'customer' AND organization_id IS NULL;
    UPDATE public.subjects SET organization_id = _org
    WHERE organization_id IS NULL;
    UPDATE public.grants g SET organization_id = s.organization_id
    FROM public.subjects s WHERE s.id = g.subject_id AND g.organization_id IS NULL;
    UPDATE public.role_permissions rp SET organization_id = r.organization_id
    FROM public.roles r WHERE r.id = rp.role_id AND rp.organization_id IS NULL;
    UPDATE public.audit_log a SET organization_id = COALESCE(
      (SELECT organization_id FROM public.profiles WHERE id = a.actor_id), _org)
    WHERE a.organization_id IS NULL;

    RAISE NOTICE 'workspace isolation backfill: % orgs present, attributed to % (% roles, % permissions, % subjects)',
      _org_count, _org, _n_roles, _n_perms, _n_subjects;
  END IF;
END $$;

ALTER TABLE public.subjects ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE public.grants ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE public.audit_log ALTER COLUMN organization_id SET NOT NULL;
-- role_permissions stays nullable: console↔console links are global (NULL).

-- Scope/org invariant, now that every customer row is attributed.
ALTER TABLE public.roles ADD CONSTRAINT roles_scope_org_check CHECK (
  (scope = 'console' AND organization_id IS NULL)
  OR (scope = 'customer' AND organization_id IS NOT NULL)
);
ALTER TABLE public.permissions ADD CONSTRAINT permissions_scope_org_check CHECK (
  (scope = 'console' AND organization_id IS NULL)
  OR (scope = 'customer' AND organization_id IS NOT NULL)
);

-- ── Cross-workspace link guards (all SECURITY DEFINER: they only enforce ────
-- ── invariants, and must keep working as RLS tightens around them) ──────────
CREATE OR REPLACE FUNCTION public.set_role_permission_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _r uuid;
  _p uuid;
BEGIN
  SELECT organization_id INTO _r FROM public.roles WHERE id = NEW.role_id;
  SELECT organization_id INTO _p FROM public.permissions WHERE id = NEW.permission_id;
  IF _r IS NULL AND _p IS NULL THEN
    NEW.organization_id := NULL;
  ELSIF _r IS NOT DISTINCT FROM _p AND _r IS NOT NULL THEN
    NEW.organization_id := _r;
  ELSE
    RAISE EXCEPTION 'Role and permission must belong to the same workspace';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS set_role_permission_org ON public.role_permissions;
CREATE TRIGGER set_role_permission_org
  BEFORE INSERT OR UPDATE OF role_id, permission_id ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.set_role_permission_org();

CREATE OR REPLACE FUNCTION public.set_grant_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _s uuid;
  _r uuid;
BEGIN
  SELECT organization_id INTO _s FROM public.subjects WHERE id = NEW.subject_id;
  SELECT organization_id INTO _r FROM public.roles WHERE id = NEW.role_id;
  IF _s IS NULL OR _r IS NULL OR _s IS DISTINCT FROM _r THEN
    RAISE EXCEPTION 'Subject and role must belong to the same workspace';
  END IF;
  NEW.organization_id := _s;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS set_grant_org ON public.grants;
CREATE TRIGGER set_grant_org
  BEFORE INSERT OR UPDATE OF role_id, subject_id ON public.grants
  FOR EACH ROW EXECUTE FUNCTION public.set_grant_org();

CREATE OR REPLACE FUNCTION public.fill_audit_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    SELECT organization_id INTO NEW.organization_id
    FROM public.profiles WHERE id = NEW.actor_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS fill_audit_org ON public.audit_log;
CREATE TRIGGER fill_audit_org
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION public.fill_audit_org();

-- The 0009 org-link guard must bypass RLS itself: its creator lookup reads
-- organizations, whose SELECT is locked down below.
CREATE OR REPLACE FUNCTION public.guard_profile_org_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

-- ── Org-scoped RLS (replaces the 0009 member-read set) ───────────────────────
DROP POLICY IF EXISTS "member read roles" ON public.roles;
DROP POLICY IF EXISTS "console manage roles" ON public.roles;
DROP POLICY IF EXISTS "console update roles" ON public.roles;
DROP POLICY IF EXISTS "console delete roles" ON public.roles;
CREATE POLICY "org read roles" ON public.roles FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid()) AND (
      (
        organization_id = public.my_organization_id()
        AND (
          public.has_console_permission(auth.uid(), 'roles.read')
          OR public.has_console_permission(auth.uid(), 'roles.manage')
          OR public.has_console_permission(auth.uid(), 'users.read')
          OR public.has_console_permission(auth.uid(), 'users.manage')
        )
      )
      OR scope = 'console'
    )
  );
CREATE POLICY "org manage roles" ON public.roles FOR INSERT TO authenticated
  WITH CHECK (
    scope = 'customer'
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'roles.manage')
  );
CREATE POLICY "org update roles" ON public.roles FOR UPDATE TO authenticated
  USING (
    scope = 'customer'
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'roles.manage')
    AND NOT is_system
  );
CREATE POLICY "org delete roles" ON public.roles FOR DELETE TO authenticated
  USING (
    scope = 'customer'
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'roles.manage')
    AND NOT is_system
  );

DROP POLICY IF EXISTS "member read permissions" ON public.permissions;
DROP POLICY IF EXISTS "console manage permissions" ON public.permissions;
DROP POLICY IF EXISTS "console update permissions" ON public.permissions;
DROP POLICY IF EXISTS "console delete permissions" ON public.permissions;
CREATE POLICY "org read permissions" ON public.permissions FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid()) AND (
      (
        organization_id = public.my_organization_id()
        AND (
          public.has_console_permission(auth.uid(), 'permissions.read')
          OR public.has_console_permission(auth.uid(), 'permissions.manage')
          OR public.has_console_permission(auth.uid(), 'roles.read')
          OR public.has_console_permission(auth.uid(), 'roles.manage')
        )
      )
      OR scope = 'console'
    )
  );
CREATE POLICY "org manage permissions" ON public.permissions FOR INSERT TO authenticated
  WITH CHECK (
    scope = 'customer'
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'permissions.manage')
  );
CREATE POLICY "org update permissions" ON public.permissions FOR UPDATE TO authenticated
  USING (
    scope = 'customer'
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'permissions.manage')
    AND NOT is_system
  );
CREATE POLICY "org delete permissions" ON public.permissions FOR DELETE TO authenticated
  USING (
    scope = 'customer'
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'permissions.manage')
    AND NOT is_system
  );

DROP POLICY IF EXISTS "member read role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "console manage role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "console delete role_permissions" ON public.role_permissions;
CREATE POLICY "org read role_permissions" ON public.role_permissions FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid()) AND (
      (
        organization_id = public.my_organization_id()
        AND (
          public.has_console_permission(auth.uid(), 'roles.read')
          OR public.has_console_permission(auth.uid(), 'roles.manage')
        )
      )
      OR organization_id IS NULL
    )
  );
CREATE POLICY "org manage role_permissions" ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (
    organization_id IS NOT NULL
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'roles.manage')
  );
CREATE POLICY "org delete role_permissions" ON public.role_permissions FOR DELETE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'roles.manage')
  );

DROP POLICY IF EXISTS "member read subjects" ON public.subjects;
DROP POLICY IF EXISTS "console manage subjects" ON public.subjects;
DROP POLICY IF EXISTS "console update subjects" ON public.subjects;
DROP POLICY IF EXISTS "console delete subjects" ON public.subjects;
CREATE POLICY "org read subjects" ON public.subjects FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.read')
      OR public.has_console_permission(auth.uid(), 'users.manage')
    )
  );
CREATE POLICY "org manage subjects" ON public.subjects FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );
CREATE POLICY "org update subjects" ON public.subjects FOR UPDATE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );
CREATE POLICY "org delete subjects" ON public.subjects FOR DELETE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );

DROP POLICY IF EXISTS "member read grants" ON public.grants;
DROP POLICY IF EXISTS "console manage grants" ON public.grants;
DROP POLICY IF EXISTS "console delete grants" ON public.grants;
CREATE POLICY "org read grants" ON public.grants FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND organization_id = public.my_organization_id()
    AND (
      public.has_console_permission(auth.uid(), 'users.read')
      OR public.has_console_permission(auth.uid(), 'users.manage')
    )
  );
CREATE POLICY "org manage grants" ON public.grants FOR INSERT TO authenticated
  WITH CHECK (
    organization_id IS NOT NULL
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );
CREATE POLICY "org delete grants" ON public.grants FOR DELETE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );

DROP POLICY IF EXISTS "member read member_roles" ON public.member_roles;
DROP POLICY IF EXISTS "manage member_roles" ON public.member_roles;
DROP POLICY IF EXISTS "delete member_roles" ON public.member_roles;
CREATE POLICY "org read member_roles" ON public.member_roles FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
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
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = member_roles.profile_id
        AND p.organization_id = public.my_organization_id()
    )
  );
CREATE POLICY "org delete member_roles" ON public.member_roles FOR DELETE TO authenticated
  USING (
    public.has_console_permission(auth.uid(), 'users.manage')
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = member_roles.profile_id
        AND p.organization_id = public.my_organization_id()
    )
  );

DROP POLICY IF EXISTS "read audit" ON public.audit_log;
CREATE POLICY "org read audit" ON public.audit_log FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid())
    AND organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'audit.read')
  );

-- Organizations: slug enumeration closes too — the request flow resolves
-- slugs inside request_to_join_org (SECURITY DEFINER), so clients only ever
-- read their own workspace (plus ones they requested).
DROP POLICY IF EXISTS "authenticated read organizations" ON public.organizations;
CREATE POLICY "org read organizations" ON public.organizations FOR SELECT TO authenticated
  USING (
    id = public.my_organization_id()
    OR EXISTS (
      SELECT 1 FROM public.organization_join_requests r
      WHERE r.organization_id = organizations.id
        AND r.profile_id = auth.uid()
        AND r.status = 'pending'
    )
  );
DROP POLICY IF EXISTS "update organizations" ON public.organizations;
CREATE POLICY "update organizations" ON public.organizations FOR UPDATE TO authenticated
  USING (
    id = public.my_organization_id()
    AND (
      created_by = auth.uid()
      OR public.has_console_permission(auth.uid(), 'organizations.manage')
    )
  );
DROP POLICY IF EXISTS "delete organizations" ON public.organizations;
CREATE POLICY "delete organizations" ON public.organizations FOR DELETE TO authenticated
  USING (created_by = auth.uid() AND id = public.my_organization_id());

-- API keys: same capability as before, now pinned to the caller's workspace.
DROP POLICY IF EXISTS "read api_keys" ON public.api_keys;
DROP POLICY IF EXISTS "manage api_keys" ON public.api_keys;
DROP POLICY IF EXISTS "revoke api_keys" ON public.api_keys;
CREATE POLICY "read api_keys" ON public.api_keys FOR SELECT TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );
CREATE POLICY "manage api_keys" ON public.api_keys FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );
CREATE POLICY "revoke api_keys" ON public.api_keys FOR UPDATE TO authenticated
  USING (
    organization_id = public.my_organization_id()
    AND public.has_console_permission(auth.uid(), 'users.manage')
  );

-- ── Management API, workspace-scoped (rewrites 0005/0007) ────────────────────
DROP FUNCTION IF EXISTS public.ensure_subject(text, text);
CREATE OR REPLACE FUNCTION public.ensure_subject(
  _organization_id uuid,
  _external_id text,
  _display_name text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
BEGIN
  IF _organization_id IS NULL THEN
    RAISE EXCEPTION 'Organization is required';
  END IF;
  INSERT INTO public.subjects (organization_id, external_id, display_name)
  VALUES (_organization_id, _external_id, NULLIF(_display_name, ''))
  ON CONFLICT (organization_id, external_id) DO UPDATE
    SET display_name = COALESCE(EXCLUDED.display_name, public.subjects.display_name)
  RETURNING id INTO _id;
  RETURN _id;
END;
$$;

DROP FUNCTION IF EXISTS public.has_permission_for_external(text, text);
CREATE OR REPLACE FUNCTION public.has_permission_for_external(
  _organization_id uuid,
  _subject_id text,
  _perm text
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.grants g
    JOIN public.roles r ON r.id = g.role_id
    JOIN public.role_permissions rp ON rp.role_id = g.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    JOIN public.subjects s ON s.id = g.subject_id
    WHERE g.organization_id = _organization_id
      AND r.organization_id = _organization_id
      AND s.organization_id = _organization_id
      AND p.organization_id = _organization_id
      AND r.scope = 'customer'
      AND s.external_id = _subject_id AND p.slug = _perm
  )
$$;

CREATE OR REPLACE FUNCTION public.api_check(_hash text, _subject text, _perm text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  RETURN public.has_permission_for_external(_org, _subject, _perm);
END;
$$;

CREATE OR REPLACE FUNCTION public.api_grant_role(_hash text, _role text, _subject text, _display_name text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _rid uuid;
  _sid uuid;
  _n int;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO _rid FROM public.roles
  WHERE slug = _role AND scope = 'customer' AND organization_id = _org;
  IF _rid IS NULL THEN RAISE EXCEPTION 'unknown_role:%', _role; END IF;
  SELECT public.ensure_subject(_org, _subject, _display_name) INTO _sid;
  INSERT INTO public.grants (organization_id, role_id, subject_id)
  VALUES (_org, _rid, _sid)
  ON CONFLICT (role_id, subject_id) DO NOTHING;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.api_revoke_grant(_hash text, _role text, _subject text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _rid uuid;
  _sid uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO _rid FROM public.roles
  WHERE slug = _role AND scope = 'customer' AND organization_id = _org;
  IF _rid IS NULL THEN RAISE EXCEPTION 'unknown_role:%', _role; END IF;
  SELECT id INTO _sid FROM public.subjects
  WHERE external_id = _subject AND organization_id = _org;
  IF _sid IS NULL THEN RETURN true; END IF;
  DELETE FROM public.grants
  WHERE role_id = _rid AND subject_id = _sid AND organization_id = _org;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.api_list_roles(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  RETURN COALESCE((
    SELECT json_agg(json_build_object('slug', slug, 'name', name, 'description', description, 'created_at', created_at) ORDER BY created_at)
    FROM public.roles WHERE scope = 'customer' AND organization_id = _org
  ), '[]'::json);
END;
$$;

CREATE OR REPLACE FUNCTION public.api_list_permissions(_hash text)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  RETURN COALESCE((
    SELECT json_agg(json_build_object('slug', slug, 'name', name, 'description', description, 'category', category, 'created_at', created_at) ORDER BY category)
    FROM public.permissions WHERE scope = 'customer' AND organization_id = _org
  ), '[]'::json);
END;
$$;

-- ── Verification (read the output after running) ────────────────────────────
SELECT 'orgs' AS check, count(*) AS count FROM public.organizations;
SELECT 'customer_roles' AS check, count(*) AS count FROM public.roles WHERE scope = 'customer';
SELECT 'roles_missing_org' AS check, count(*) AS count FROM public.roles
WHERE scope = 'customer' AND organization_id IS NULL;
SELECT 'perms_missing_org' AS check, count(*) AS count FROM public.permissions
WHERE scope = 'customer' AND organization_id IS NULL;
SELECT 'subjects_missing_org' AS check, count(*) AS count FROM public.subjects WHERE organization_id IS NULL;
SELECT 'grants_missing_org' AS check, count(*) AS count FROM public.grants WHERE organization_id IS NULL;
SELECT 'audit_missing_org' AS check, count(*) AS count FROM public.audit_log WHERE organization_id IS NULL;
SELECT 'roleperms_missing_org' AS check, count(*) AS count FROM public.role_permissions WHERE organization_id IS NULL;
SELECT 'per_org_subjects' AS check, organization_id AS name, count(*) AS count FROM public.subjects GROUP BY organization_id;
