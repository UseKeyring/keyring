-- 0015 BACKUPS SYSTEM
--
-- Add backup functionality with 7-day retention for organization data.
-- Backups are stored in Supabase storage and metadata tracked in database.
--
-- Apply in the Supabase SQL editor.

-- Create backups table to track backup metadata
CREATE TABLE IF NOT EXISTS public.backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  storage_path text NOT NULL,
  size_bytes bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS backups_organization_id_idx ON public.backups (organization_id);
CREATE INDEX IF NOT EXISTS backups_created_at_idx ON public.backups (created_at DESC);
CREATE INDEX IF NOT EXISTS backups_status_idx ON public.backups (status) WHERE status = 'pending';

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backups TO authenticated;
GRANT ALL ON public.backups TO service_role;

-- Enable RLS
ALTER TABLE public.backups ENABLE ROW LEVEL SECURITY;

-- RLS policies for backups
CREATE POLICY "Users can view their own organization backups"
  ON public.backups FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM public.organization_members 
      WHERE profile_id = auth.uid()
    )
  );

CREATE POLICY "Organization managers can create backups"
  ON public.backups FOR INSERT
  WITH CHECK (
    public.is_org_manager(auth.uid(), organization_id)
  );

CREATE POLICY "Organization managers can update backups"
  ON public.backups FOR UPDATE
  USING (
    public.is_org_manager(auth.uid(), organization_id)
  );

CREATE POLICY "Organization managers can delete backups"
  ON public.backups FOR DELETE
  USING (
    public.is_org_manager(auth.uid(), organization_id)
  );

-- Function to create a backup
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

  -- Create backup record with RLS bypass
  INSERT INTO public.backups (organization_id, storage_path, created_by, status)
  VALUES (_organization_id, _storage_path, auth.uid(), 'pending')
  RETURNING id INTO _backup_id;

  RETURN _backup_id;
END;
$$;

-- Function to mark backup as completed
CREATE OR REPLACE FUNCTION public.complete_backup(_backup_id uuid, _size_bytes bigint DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.backups
  SET status = 'completed',
      completed_at = now(),
      size_bytes = _size_bytes
  WHERE id = _backup_id;
END;
$$;

-- Function to mark backup as failed
CREATE OR REPLACE FUNCTION public.fail_backup(_backup_id uuid, _error_message text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.backups
  SET status = 'failed',
      completed_at = now(),
      error_message = _error_message
  WHERE id = _backup_id;
END;
$$;

-- Function to clean up old backups (keep last 7 days)
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

-- Function to get organization data for backup
CREATE OR REPLACE FUNCTION public.get_organization_backup_data(_organization_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
SELECT jsonb_build_object(
  'organization', (
    SELECT row_to_json(o) FROM public.organizations o WHERE o.id = _organization_id
  ),
  'roles', (
    SELECT jsonb_agg(row_to_json(r)) 
    FROM public.roles r 
    WHERE r.organization_id = _organization_id
  ),
  'permissions', (
    SELECT jsonb_agg(row_to_json(p)) 
    FROM public.permissions p 
    WHERE p.organization_id = _organization_id
  ),
  'role_permissions', (
    SELECT jsonb_agg(row_to_json(rp)) 
    FROM public.role_permissions rp 
    WHERE rp.organization_id = _organization_id
  ),
  'subjects', (
    SELECT jsonb_agg(row_to_json(s)) 
    FROM public.subjects s 
    WHERE s.organization_id = _organization_id
  ),
  'grants', (
    SELECT jsonb_agg(row_to_json(g)) 
    FROM public.grants g 
    WHERE g.organization_id = _organization_id
  ),
  'member_roles', (
    SELECT jsonb_agg(row_to_json(mr)) 
    FROM public.member_roles mr 
    WHERE mr.organization_id = _organization_id
  ),
  'organization_members', (
    SELECT jsonb_agg(row_to_json(om)) 
    FROM public.organization_members om 
    WHERE om.organization_id = _organization_id
  ),
  'audit_log', (
    SELECT jsonb_agg(row_to_json(al)) 
    FROM public.audit_log al 
    WHERE al.organization_id = _organization_id
  ),
  'backed_up_at', now()
);
$$;

-- Add console permission for backup management
INSERT INTO public.permissions (slug, name, description, category, is_system, scope)
VALUES ('backups.manage', 'Manage backups', 'Create, view and restore organization backups', 'Console', true, 'console')
ON CONFLICT DO NOTHING;

-- Grant backup permission to console-manager role
INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM public.roles r, public.permissions p
WHERE r.slug = 'console-manager' AND r.scope = 'console' 
  AND p.slug = 'backups.manage' AND p.scope = 'console'
ON CONFLICT DO NOTHING;
