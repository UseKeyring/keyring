-- 0005 LAZY SUBJECT PROVISIONING
--
-- ensure_subject() lets backends register a subject on first check instead
-- of requiring a signup webhook. It is fail-closed: minting a subject grants
-- nothing — access still comes only from explicit grants made in the console.
-- Apply in the Supabase SQL editor.

CREATE OR REPLACE FUNCTION public.ensure_subject(
  _external_id text,
  _display_name text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _id uuid;
BEGIN
  INSERT INTO public.subjects (external_id, display_name)
  VALUES (_external_id, NULLIF(_display_name, ''))
  ON CONFLICT (external_id) DO UPDATE
    SET display_name = COALESCE(EXCLUDED.display_name, public.subjects.display_name)
  RETURNING id INTO _id;
  RETURN _id;
END;
$$;
