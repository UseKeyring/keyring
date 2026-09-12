-- 0014 DISPLAY NAME FOR GRANTS API
--
-- Add display_name parameter to api_grant_role so developers can
-- create subjects with readable names via the Management API instead
-- of manually entering them in the dashboard.
--
-- Apply in the Supabase SQL editor.

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
