-- 0043 FIX MIRROR KEY ISSUANCE
--
-- 0041's api_issue_mirror_key lists 7 target columns but only 6 VALUES
-- expressions (created_by has no expression), so every call fails with
-- `INSERT has more target columns than expressions` at the mirror_key step.
-- Fixed here by inheriting created_by from the calling key (same operator),
-- falling back to NULL when the caller carries none.
-- Apply in the Supabase SQL editor (idempotent).

CREATE OR REPLACE FUNCTION public.api_issue_mirror_key(
  _hash text, _name text, _key_hash text, _prefix text, _scopes text[]
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _creator uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'integrations.write') THEN RETURN NULL; END IF;
  SELECT organization_id, created_by INTO _org, _creator FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.api_keys (organization_id, name, key_hash, prefix, key_type, scopes, created_by)
  VALUES (_org, _name, _key_hash, _prefix, 'secret', _scopes, _creator)
  RETURNING id INTO _row;
  RETURN json_build_object('id', _row.id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_issue_mirror_key(text, text, text, text, text[]) TO anon, authenticated, service_role;
