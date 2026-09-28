-- 0036 WEBHOOK SECRET: SERVER-GENERATED AT CREATION
--
-- Like API keys: the operator never types the secret. The create form sends
-- name/url/events only; the database mints `kr_ws_live_…` (same 32-byte
-- base64url body as API keys, own prefix) in a BEFORE trigger, and the raw
-- value is returned ONCE in the creation response / post-insert readback.
-- Afterwards it is never displayed (list/detail queries exclude it; reset
-- mints a fresh one the same way).
--
-- No extension needed: two gen_random_uuid() give 32 bytes of entropy,
-- re-encoded to base64url — identical alphabet and strength to api-keys.ts.
-- Apply in the Supabase SQL editor (idempotent).

-- ── Generator (same format as newApiKey/newWebhookSecret) ───────────────────
CREATE OR REPLACE FUNCTION public.generate_webhook_secret()
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT 'kr_ws_live_' || rtrim(
    translate(
      encode(
        decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'),
        'base64'
      ),
      '+/', '-_'
    ),
    '='
  );
$$;

-- ── Fill trigger: INSERT without secret, or UPDATE resetting it to NULL/'' ──
CREATE OR REPLACE FUNCTION public.fill_webhook_secret()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.secret IS NULL OR NEW.secret = '' THEN
    NEW.secret := public.generate_webhook_secret();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fill_webhook_secret ON public.webhook_endpoints;
CREATE TRIGGER trg_fill_webhook_secret
  BEFORE INSERT OR UPDATE OF secret ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.fill_webhook_secret();

-- Belt-and-braces: user-supplied secrets (API path) keep the min length.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_endpoints_secret_len_check'
  ) THEN
    ALTER TABLE public.webhook_endpoints
      ADD CONSTRAINT webhook_endpoints_secret_len_check CHECK (length(secret) >= 16);
  END IF;
END;
$$;

-- ── api_create_webhook_endpoint: secret optional, returned ONCE ──────────────
-- NOTE: 0034 defined _secret WITHOUT a default, so CREATE OR REPLACE cannot
-- add DEFAULT NULL (42P13). Drop first — same signature, so dependents are
-- unaffected; the GRANT below re-applies.
DROP FUNCTION IF EXISTS public.api_create_webhook_endpoint(text, text, text, text, text[]);
CREATE OR REPLACE FUNCTION public.api_create_webhook_endpoint(
  _hash text, _name text, _url text, _secret text DEFAULT NULL, _events text[] DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _row record;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'webhooks.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _name IS NULL OR btrim(_name) = '' THEN RAISE EXCEPTION 'invalid_name:name required'; END IF;
  IF _url IS NULL OR _url NOT LIKE 'https://%' THEN RAISE EXCEPTION 'invalid_url:want https://…'; END IF;
  -- NULL/empty _secret falls through to the fill trigger (server-generated).
  IF _secret IS NOT NULL AND _secret <> '' AND length(_secret) < 16 THEN
    RAISE EXCEPTION 'invalid_secret:min 16 chars';
  END IF;
  INSERT INTO public.webhook_endpoints (organization_id, name, url, secret, events)
  VALUES (_org, btrim(_name), btrim(_url), NULLIF(_secret, ''), COALESCE(_events, '{}'))
  RETURNING id, name, url, secret, events, active, created_at INTO _row;
  RETURN json_build_object(
    'id', _row.id, 'name', _row.name, 'url', _row.url,
    'secret', _row.secret,
    'events', _row.events, 'active', _row.active, 'created_at', _row.created_at
  );
END;
$$;
GRANT EXECUTE ON FUNCTION public.api_create_webhook_endpoint(text, text, text, text, text[]) TO anon, authenticated, service_role;
