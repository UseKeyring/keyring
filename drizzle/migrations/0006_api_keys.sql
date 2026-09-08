-- 0006 API KEYS
--
-- Developers authenticate to the management API with issued keys, never the
-- Supabase service_role key. Only the SHA-256 hash is stored; the full key
-- is shown once at creation. Revocation is a timestamp (auditable, instant).
-- Apply in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_keys TO authenticated;
GRANT ALL ON public.api_keys TO service_role;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- Listing/issuing keys is a management action; reads stay with managers too
-- since even prefixes identify live credentials.
DROP POLICY IF EXISTS "read api_keys" ON public.api_keys;
CREATE POLICY "read api_keys" ON public.api_keys FOR SELECT TO authenticated
  USING (public.has_console_permission(auth.uid(), 'users.manage'));

DROP POLICY IF EXISTS "manage api_keys" ON public.api_keys;
CREATE POLICY "manage api_keys" ON public.api_keys FOR INSERT TO authenticated
  WITH CHECK (public.has_console_permission(auth.uid(), 'users.manage'));

DROP POLICY IF EXISTS "revoke api_keys" ON public.api_keys;
CREATE POLICY "revoke api_keys" ON public.api_keys FOR UPDATE TO authenticated
  USING (public.has_console_permission(auth.uid(), 'users.manage'));
