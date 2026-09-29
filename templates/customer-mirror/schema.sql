-- ══════════════════════════════════════════════════════════════════════
-- KEYRING CUSTOMER MIRROR (run in YOUR Supabase / Neon database, once)
-- Single-org: no organization_id column — this DB belongs to one workspace.
-- Expiry: rows STAY, helpers FILTER (expires_at IS NULL OR > now()).
-- Writes: ONLY the webhook applier (service_role) writes here. No client
-- insert/update/delete policies are created on purpose.
-- REQUIRED AFTER RUNNING: Dashboard → Settings → API → Exposed schemas →
-- add `keyring`. Without this, PostgREST rejects every mirror write with
-- `Invalid schema: keyring` and the applier can never land rows.
-- ══════════════════════════════════════════════════════════════════════

create schema if not exists keyring;

-- Denormalized mirror: one row per (subject, role, permission).
-- Powers both keyring.has(role) and keyring.can(permission) with one index.
create table if not exists keyring.access (
  subject_id text not null,
  role_slug text not null,
  perm_slug text not null,
  expires_at timestamptz null,
  updated_at timestamptz not null default now(),
  primary key (subject_id, role_slug, perm_slug)
);
create index if not exists keyring_access_subject_perm_idx
  on keyring.access (subject_id, perm_slug);
create index if not exists keyring_access_subject_role_idx
  on keyring.access (subject_id, role_slug);
-- Note: no partial WHERE (expires_at …) here — now() is STABLE, not
-- IMMUTABLE, so Postgres rejects it in index predicates (42P17). Expiry is
-- filtered at query time inside keyring.has()/can() instead.

-- Provision log: written by signup-sync.ts on success. The nightly reconcile
-- provisions auth users ABSENT from this table — never present ones, so
-- deliberately revoked users stay revoked. Service_role only, like access.
create table if not exists keyring.provision_log (
  subject_id text primary key,
  role_slug text not null,
  provisioned_at timestamptz not null default now()
);

-- ── Least privilege on the mirror ───────────────────────────────────────────
-- RLS enabled with NO policies = deny-by-default for anon / authenticated
-- (they hold no grants either — verified). service_role bypasses RLS, the
-- SECURITY DEFINER helpers below run as the table owner, and the applier +
-- signup-sync both use service_role — so nothing legitimate is blocked.
alter table if exists keyring.access enable row level security;
alter table if exists keyring.provision_log enable row level security;
grant usage on schema keyring to service_role;
grant all on keyring.access to service_role;
grant all on keyring.provision_log to service_role;

-- ── Supabase helper: role check ─────────────────────────────────────────────
-- Usage:  create policy "teachers insert records" on public.records
--         for insert to authenticated with check (keyring.has('teacher'));
-- Note: params are underscore-prefixed so they can never collide with column
-- names (same convention as Keyring's own _subject/_perm functions).
create or replace function keyring.has(_role text)
returns boolean
language sql stable security definer set search_path = keyring, public as $$
  select exists (
    select 1 from keyring.access
    where subject_id = auth.uid()::text
      and role_slug = _role
      and (expires_at is null or expires_at > now())
  )
$$;
grant execute on function keyring.has(text) to authenticated, anon;

-- ── Supabase helper: capability check ───────────────────────────────────────
-- Usage:  create policy "refund" on public.invoices
--         for update to authenticated using (keyring.can('invoices.refund'));
create or replace function keyring.can(_perm text)
returns boolean
language sql stable security definer set search_path = keyring, public as $$
  select exists (
    select 1 from keyring.access
    where subject_id = auth.uid()::text
      and perm_slug = _perm
      and (expires_at is null or expires_at > now())
  )
$$;
grant execute on function keyring.can(text) to authenticated, anon;

-- ── Neon variant ────────────────────────────────────────────────────────────
-- Neon has no auth.uid(). Set app.uid per request from your API layer after
-- keyring.check(), then use these instead:
--   select set_config('app.uid', 'user_abc123', true);
create or replace function keyring.has_for(_subject text, _role text)
returns boolean
language sql stable security definer set search_path = keyring, public as $$
  select exists (
    select 1 from keyring.access
    where subject_id = _subject
      and role_slug = _role
      and (expires_at is null or expires_at > now())
  )
$$;
create or replace function keyring.can_for(_subject text, _perm text)
returns boolean
language sql stable security definer set search_path = keyring, public as $$
  select exists (
    select 1 from keyring.access
    where subject_id = _subject
      and perm_slug = _perm
      and (expires_at is null or expires_at > now())
  )
$$;

-- ── Example policies (adapt table/role names) ───────────────────────────────
-- create policy "teachers insert records" on public.records
-- for insert to authenticated with check (keyring.has('teacher'));
--
-- create policy "clinicians read doctors" on public.doctors
-- for select to authenticated using (keyring.has('clinician'));
--
-- create policy "refund own invoices" on public.invoices
-- for update to authenticated
-- using (author_id = auth.uid() and keyring.can('invoices.refund'));
