-- 0045 WEBHOOK ENDPOINT CREATION FROM CONNECT ORCHESTRATION
--
-- The Supabase one-click connect (verify route) mints the mirror webhook
-- endpoint with an integrations-scoped Keyring key. Accept integrations.write
-- here alongside webhooks.write so the orchestration doesn't need a second
-- scope. Pasted connect keys carrying only integrations.write work.
-- Apply in the Supabase SQL editor (idempotent).

CREATE OR REPLACE FUNCTION public.api_create_webhook_endpoint(
  _hash text, _name text, _url text, _secret text, _events text[] DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT (
    public.api_key_has_scope(_key, 'webhooks.write')
    OR public.api_key_has_scope(_key, 'integrations.write')
  ) THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _name IS NULL OR btrim(_name) = '' THEN RAISE EXCEPTION 'invalid_name:name required'; END IF;
  IF _url IS NULL OR _url NOT LIKE 'https://%' THEN RAISE EXCEPTION 'invalid_url:want https://…'; END IF;
  IF _secret IS NULL OR length(_secret) < 16 THEN RAISE EXCEPTION 'invalid_secret:min 16 chars'; END IF;
  INSERT INTO public.webhook_endpoints (organization_id, name, url, secret, events)
  VALUES (_org, btrim(_name), btrim(_url), _secret, COALESCE(_events, '{}'))
  RETURNING id, name, url, events, active, created_at INTO _row;
  RETURN json_build_object(
    'id', _row.id, 'name', _row.name, 'url', _row.url,
    'events', _row.events, 'active', _row.active, 'created_at', _row.created_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.api_create_webhook_endpoint(text, text, text, text, text[]) TO anon, authenticated, service_role;
