-- 0042 API KEY INTEGRATIONS SCOPE
--
-- 0041 added `integrations.write` (connect-flow RPCs re-verify it on every
-- call) but never allow-listed it in guard_api_key_scopes(), so creating or
-- updating a key carrying it fails with `invalid_api_key_scope:...` (400 on
-- POST /rest/v1/api_keys). This brings the guard up to the full built-in
-- list the console issues (matches src/lib/api-key-scopes.ts):
--   check, grants.write, roles.read, roles.write, actions.read,
--   actions.write, subject_tokens.write, telemetry.read, telemetry.write,
--   webhooks.read, webhooks.write, integrations.write
-- Apply in the Supabase SQL editor (idempotent).

CREATE OR REPLACE FUNCTION public.guard_api_key_scopes()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  _allowed text[] := ARRAY[
    'check',
    'grants.write',
    'roles.read',
    'roles.write',
    'actions.read',
    'actions.write',
    'subject_tokens.write',
    'telemetry.read',
    'telemetry.write',
    'webhooks.read',
    'webhooks.write',
    'integrations.write'
  ];
  _pub text[] := ARRAY['check'];
  _s text;
BEGIN
  IF NEW.scopes IS NULL THEN
    NEW.scopes := '{}';
  END IF;

  FOREACH _s IN ARRAY NEW.scopes LOOP
    IF NOT (_s = ANY (_allowed)) THEN
      RAISE EXCEPTION 'invalid_api_key_scope:%', _s;
    END IF;
  END LOOP;

  IF NEW.key_type = 'publishable' THEN
    FOREACH _s IN ARRAY NEW.scopes LOOP
      IF NOT (_s = ANY (_pub)) THEN
        RAISE EXCEPTION 'publishable_scope_forbidden:%', _s;
      END IF;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_api_key_scopes ON public.api_keys;
CREATE TRIGGER trg_guard_api_key_scopes
  BEFORE INSERT OR UPDATE OF scopes, key_type ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.guard_api_key_scopes();

-- Least-privilege upgrade (mirrors 0034): secret keys that can already manage
-- grants gain webhook + integration management too (same operator persona).
-- Keys without grants.write gain nothing.
UPDATE public.api_keys
SET scopes = array(SELECT DISTINCT unnest(scopes || ARRAY['webhooks.read', 'webhooks.write', 'integrations.write']) ORDER BY 1)
WHERE key_type = 'secret'
  AND 'grants.write' = ANY (scopes)
  AND NOT ('integrations.write' = ANY (scopes));
