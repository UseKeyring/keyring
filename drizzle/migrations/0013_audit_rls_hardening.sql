-- 0013 AUDIT FK + CONSOLE-PLANE READ HARDENING
--
-- Fixes two issues found in review:
--   1. audit_log.organization_id was NOT NULL with ON DELETE SET NULL, so
--      deleting a workspace could never succeed (SET NULL violates NOT NULL).
--      Audit rows are workspace-owned: cascade them like every other
--      customer-plane table.
--   2. "org read roles / permissions / role_permissions" exposed the global
--      console plane (scope='console' / organization_id IS NULL) to ANY
--      workspace member with no permission check. Console rows are invisible
--      by design (see useRbac isCustomerRole filter) — require the same
--      read permission on the console branch.
--
-- Every statement is idempotent. Apply in the Supabase SQL editor.

-- ── 1. audit_log FK: SET NULL → CASCADE ─────────────────────────────────────
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_organization_id_fkey;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- ── 2. Console-plane reads require permission ───────────────────────────────
DROP POLICY IF EXISTS "org read roles" ON public.roles;
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
      OR (
        scope = 'console'
        AND (
          public.has_console_permission(auth.uid(), 'roles.read')
          OR public.has_console_permission(auth.uid(), 'roles.manage')
          OR public.has_console_permission(auth.uid(), 'users.read')
          OR public.has_console_permission(auth.uid(), 'users.manage')
        )
      )
    )
  );

DROP POLICY IF EXISTS "org read permissions" ON public.permissions;
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
      OR (
        scope = 'console'
        AND (
          public.has_console_permission(auth.uid(), 'permissions.read')
          OR public.has_console_permission(auth.uid(), 'permissions.manage')
          OR public.has_console_permission(auth.uid(), 'roles.read')
          OR public.has_console_permission(auth.uid(), 'roles.manage')
        )
      )
    )
  );

DROP POLICY IF EXISTS "org read role_permissions" ON public.role_permissions;
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
      OR (
        organization_id IS NULL
        AND (
          public.has_console_permission(auth.uid(), 'roles.read')
          OR public.has_console_permission(auth.uid(), 'roles.manage')
        )
      )
    )
  );

-- ── Verification (read the output after running) ────────────────────────────
SELECT 'audit_fk' AS check, confdeltype AS delete_rule
FROM pg_constraint WHERE conname = 'audit_log_organization_id_fkey';
SELECT 'policies' AS check, policyname AS name FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('roles', 'permissions', 'role_permissions')
  AND policyname LIKE 'org read%'
ORDER BY tablename, policyname;
