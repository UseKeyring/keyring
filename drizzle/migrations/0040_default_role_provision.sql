-- 0040 WORKSPACE DEFAULT ROLE + PROVISION RPC
--
-- The workspace operator picks a default role in console Settings; new
-- signups are provisioned into it via POST /api/v1/subjects/provision.
-- No role slug crosses the wire — the server resolves the default, so a
-- customer secret can never choose (or escalate to) another role.
-- Changing the default affects future signups only; existing grants are
-- never touched (explicit revoke removes someone).
-- Apply in the Supabase SQL editor (idempotent).

-- ── Default role pointer ───────────────────────────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS default_role_id uuid REFERENCES public.roles(id) ON DELETE SET NULL;

-- Guard: the default must be a customer-scope role of THIS workspace.
CREATE OR REPLACE FUNCTION public.check_default_role_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.default_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.roles
    WHERE id = NEW.default_role_id
      AND scope = 'customer'
      AND organization_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'invalid_default_role:must be a customer role of this workspace';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_check_default_role_org ON public.organizations;
CREATE TRIGGER trg_check_default_role_org
  BEFORE INSERT OR UPDATE OF default_role_id ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.check_default_role_org();

-- ── Provision RPC (key-authed, org-scoped) ─────────────────────────────────
-- Grants the workspace default to a subject (auto-provisioned, idempotent).
-- Returns { subject, role, granted } — granted=false when already held.
-- No default configured → 'no_default_role' (fail-closed, signup fn logs).
CREATE OR REPLACE FUNCTION public.api_provision_subject(
  _hash text, _subject text, _display_name text DEFAULT NULL
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _key uuid;
  _org uuid;
  _rid uuid;
  _slug text;
  _sid uuid;
  _n int;
BEGIN
  SELECT public._api_key_id(_hash) INTO _key;
  IF _key IS NULL THEN RETURN NULL; END IF;
  IF NOT public.api_key_has_scope(_key, 'grants.write') THEN RETURN NULL; END IF;
  SELECT organization_id INTO _org FROM public.api_keys WHERE id = _key;
  IF _org IS NULL THEN RETURN NULL; END IF;
  IF _subject IS NULL OR btrim(_subject) = '' THEN
    RAISE EXCEPTION 'invalid_subject:subject required';
  END IF;

  SELECT default_role_id INTO _rid FROM public.organizations WHERE id = _org;
  IF _rid IS NULL THEN RAISE EXCEPTION 'no_default_role:set one in workspace Settings'; END IF;
  SELECT slug INTO _slug FROM public.roles
  WHERE id = _rid AND scope = 'customer' AND organization_id = _org;
  IF _slug IS NULL THEN RAISE EXCEPTION 'invalid_default_role:re-pick it in workspace Settings'; END IF;

  SELECT public.ensure_subject(_org, btrim(_subject), _display_name) INTO _sid;
  INSERT INTO public.grants (organization_id, role_id, subject_id)
  VALUES (_org, _rid, _sid)
  ON CONFLICT (role_id, subject_id) DO NOTHING;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN json_build_object('subject', btrim(_subject), 'role', _slug, 'granted', _n = 1);
END;
$$;
GRANT EXECUTE ON FUNCTION public.api_provision_subject(text, text, text) TO anon, authenticated, service_role;
