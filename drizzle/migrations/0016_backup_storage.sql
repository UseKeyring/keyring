-- 0016 BACKUP STORAGE BUCKET
--
-- Create a storage bucket for storing organization backups.
-- This needs to be run after the backups table migration.
--
-- Apply in the Supabase SQL editor.

-- Create storage bucket for backups
INSERT INTO storage.buckets (id, name, public)
VALUES ('backups', 'backups', false)
ON CONFLICT (id) DO NOTHING;

-- Grant permissions for the backups bucket
CREATE POLICY "Users can view their own organization backups"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'backups'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.organizations
      WHERE id IN (
        SELECT organization_id FROM public.organization_members 
        WHERE profile_id = auth.uid()
      )
    )
  );

CREATE POLICY "Organization managers can upload backups"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'backups'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.organizations o
      WHERE public.is_org_manager(auth.uid(), o.id)
    )
  );

CREATE POLICY "Organization managers can delete backups"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'backups'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.organizations o
      WHERE public.is_org_manager(auth.uid(), o.id)
    )
  );
