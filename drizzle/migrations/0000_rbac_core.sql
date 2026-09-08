-- PROFILES
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ROLES
CREATE TABLE public.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.roles TO authenticated;
GRANT ALL ON public.roles TO service_role;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

-- PERMISSIONS (actions)
CREATE TABLE public.permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'general',
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.permissions TO authenticated;
GRANT ALL ON public.permissions TO service_role;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;

-- ROLE <-> PERMISSION
CREATE TABLE public.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, permission_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permissions TO authenticated;
GRANT ALL ON public.role_permissions TO service_role;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

-- USER <-> ROLE
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- AUDIT LOG
CREATE TABLE public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  action text NOT NULL,
  target text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.audit_log TO authenticated;
GRANT ALL ON public.audit_log TO service_role;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- FUNCTIONS
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _slug text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = _user_id AND r.slug = _slug
  )
$$;

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _perm text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(_user_id, 'admin') OR EXISTS (
    SELECT 1 FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = _user_id AND p.slug = _perm
  )
$$;

-- POLICIES
CREATE POLICY "read own profile or with users.read" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.has_permission(auth.uid(), 'users.read'));
CREATE POLICY "update own profile" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.has_permission(auth.uid(), 'users.manage'));
CREATE POLICY "insert own profile" ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

CREATE POLICY "authenticated read roles" ON public.roles FOR SELECT TO authenticated USING (true);
CREATE POLICY "manage roles" ON public.roles FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'roles.manage'));
CREATE POLICY "update roles" ON public.roles FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'roles.manage') AND NOT is_system);
CREATE POLICY "delete roles" ON public.roles FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'roles.manage') AND NOT is_system);

CREATE POLICY "authenticated read permissions" ON public.permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "insert permissions" ON public.permissions FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'permissions.manage'));
CREATE POLICY "update permissions" ON public.permissions FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'permissions.manage') AND NOT is_system);
CREATE POLICY "delete permissions" ON public.permissions FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'permissions.manage') AND NOT is_system);

CREATE POLICY "authenticated read role_permissions" ON public.role_permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "insert role_permissions" ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'roles.manage'));
CREATE POLICY "delete role_permissions" ON public.role_permissions FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'roles.manage'));

CREATE POLICY "read user_roles" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_permission(auth.uid(), 'users.read'));
CREATE POLICY "insert user_roles" ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'users.manage'));
CREATE POLICY "delete user_roles" ON public.user_roles FOR DELETE TO authenticated
  USING (public.has_permission(auth.uid(), 'users.manage'));

CREATE POLICY "read audit" ON public.audit_log FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'audit.read'));
CREATE POLICY "insert audit" ON public.audit_log FOR INSERT TO authenticated
  WITH CHECK (actor_id = auth.uid());

-- NOTE: fresh workspaces start empty on purpose. Console accounts operate
-- the workspace and are never RBAC subjects; roles/actions/grants are created
-- by the team for external apps. (Historical seed data was removed; 0002
-- wipes it from databases that already applied this file.)

-- NEW USER HANDLER: profile row only, never any role assignment

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, COALESCE(NEW.email, ''), NEW.raw_user_meta_data ->> 'full_name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();