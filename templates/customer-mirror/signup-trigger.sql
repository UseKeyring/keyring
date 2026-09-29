-- ══════════════════════════════════════════════════════════════════════
-- KEYRING SIGNUP TRIGGER (run in YOUR Supabase project)
-- Alternative to Dashboard → Database → Webhooks click-path: a Postgres
-- trigger on auth.users that POSTs every new signup to your keyring-signup
-- Edge Function, which provisions them into the Keyring default role.
-- ══════════════════════════════════════════════════════════════════════
--
-- BEFORE YOU RUN: replace these three values —
--   <YOUR-PROJECT-REF>  e.g. agfvgcuyvydfzfjvioeu
--   <SIGNUP_SHARED_SECRET>  the same value as the SIGNUP_SHARED_SECRET
--     secret on your keyring-signup function (generate: python3 -c
--     "import secrets; print(secrets.token_urlsafe(32))")
--
-- Requires pg_net (Dashboard → Database → Extensions → enable pg_net).
-- Best-effort by design: the trigger NEVER fails a signup. If pg_net is
-- missing, the secret mismatches, or Keyring is down, the user still gets
-- created (holding nothing — fail-closed) and the nightly reconcile heals
-- them. The secret lives in a config table readable only by service_role +
-- this SECURITY DEFINER function — never in the function body, never
-- visible to browser sessions.

-- ── Config (one row) ───────────────────────────────────────────────────────
create schema if not exists keyring;

create table if not exists keyring.signup_config (
  id integer primary key default 1 check (id = 1),
  function_url text not null,
  shared_secret text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table keyring.signup_config enable row level security;
-- Intentionally NO policies: service_role + SECURITY DEFINER only.

insert into keyring.signup_config (id, function_url, shared_secret)
values (
  1,
  'https://<YOUR-PROJECT-REF>.supabase.co/functions/v1/keyring-signup',
  '<SIGNUP_SHARED_SECRET>'
)
on conflict (id) do update set
  function_url = excluded.function_url,
  shared_secret = excluded.shared_secret,
  enabled = true;

-- ── Trigger: auth.users INSERT → POST { record: { id, email } } ────────────
create or replace function public.keyring_signup_hook()
returns trigger language plpgsql security definer set search_path = public, keyring, net as $$
declare
  v_url text;
  v_key text;
  v_enabled boolean;
begin
  select function_url, shared_secret, enabled
    into v_url, v_key, v_enabled
  from keyring.signup_config where id = 1;
  if not found or not v_enabled then return new; end if;
  begin
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object(
        'record', jsonb_build_object('id', NEW.id, 'email', NEW.email)
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Signup-Key', v_key
      )
    );
  exception when others then
    -- Best-effort only: never break a signup. Reconcile heals the gap.
    return new;
  end;
  return new;
end;
$$;

drop trigger if exists trg_keyring_signup on auth.users;
create trigger trg_keyring_signup
  after insert on auth.users
  for each row execute function public.keyring_signup_hook();

-- ── Verify ─────────────────────────────────────────────────────────────────
-- 1. Sign up a throwaway user (or INSERT a test row if you must — prefer a
--    real signup via Authentication → Add user).
-- 2. Keyring console → subjects: new UUID subject holding the default role.
-- 3. Your DB: select * from keyring.access where subject_id = '<new-uuid>';
-- 4. As that user: select keyring.has('<default-role-slug>'); → true.
--
-- To pause without dropping: update keyring.signup_config set enabled = false.
