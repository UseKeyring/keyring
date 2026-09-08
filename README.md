# Keyring — Access Controller Hub

RBAC provider platform built with **Next.js**. Create actions, compose them into roles, and grant roles to your product's users (external subjects).

Console accounts operate the workspace — they are never part of the RBAC graph. The graph starts empty: no seeded roles, actions, or grants. Check access with `has_permission_for_external(external_id, action)`.

## Design system

Polar-inspired tokens (`src/app/globals.css`):

- Ink-as-voltage: pure-black `#000000` pill CTA on a pure-white `#ffffff` canvas
- Ink-navy `#4c4f69` — body and display text; muted `#7c7f93`, subtle `#9a9ba2`
- Pillar cards `#f7f7f7`, hairline `#e6e6e6`, no shadows anywhere
- Catppuccin accents wired but withheld — blue `#1e66f5` renders as inline link text only
- Binary radius: sharp `0px` surfaces or `9999px` pills, nothing between
- Typography: Inter/InterDisplay display at weight 400 (hero 128px, `-0.025em` tracking), GeistMono 12px eyebrows and code
- Decoration: hand-drawn one-stroke line glyphs (`src/app/glyphs.tsx`), never filled icons
- Console: Polar merchant-dashboard language — always-dark sidebar shell (`dashboard-chrome.tsx`), 16px rounded panels on graphite, thin tabular numerals, icon nav with highlighted active item, white-pill CTAs. Marketing radius rules don't apply here.

## Development

```sh
npm i
npm run dev
```

Set Supabase env vars (see `.env.example`):

```sh
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=...
```

## Integrating your auth (Supabase, Clerk, WorkOS, anything)

Keyring never touches your login system. It answers one question per request —
"may this subject do this action?" — and you supply the subject ID from
whatever auth you already run. Map your provider's stable user ID to a
Keyring subject once, then check on every request.

| Your auth | Subject ID to register |
|---|---|
| Supabase Auth | `user.id` (`auth.uid()::text`) |
| Clerk | `user.id` from `auth()` |
| WorkOS | `user.id` from `withAuth()` |
| Anything else | Whatever stable ID your system issues |

**1. Register the user as a subject** — pick one pattern, or combine them.
The link is created once per user; access changes after that never touch code.

- *Manual* — add them on the Users page in this console.
- *Webhook* — on signup in your system (`auth.users` trigger, Clerk
  `user.created`, WorkOS `user.created`), insert the row:

```sql
insert into subjects (external_id, display_name)
values ('user_abc123', 'Ada Lovelace')
on conflict (external_id) do nothing;
```

- *Lazy (no signup plumbing at all)* — ensure on first check, right in the
  request path. Minting a subject grants nothing, so this is fail-closed:

```ts
await supabase.rpc("ensure_subject", {
  _external_id: user.id,
  _display_name: user.email ?? null,
});
const { data: allowed } = await supabase.rpc("has_permission_for_external", {
  _external_id: user.id,
  _perm: "invoices.refund",
});
```

What stays manual, and what doesn't:

- *Role changes* (grant/revoke) → Keyring console, point and click, instant,
  audited. Never a deploy, never a code change.
- *Suspending a user* → revoke their grants (Users page) or delete the
  subject row (grants cascade away). Re-adding later restores nothing by
  default — also fail-closed.
- *Profile edits* (name/email) → cosmetic `display_name` only; access keys
  off the immutable `external_id`, so renames break nothing.

Then grant roles in the console (Users page) or in SQL:

```sql
insert into grants (role_id, subject_id)
select r.id, s.id from roles r, subjects s
where r.slug = 'editor' and s.external_id = 'user_abc123';
```

**2. Check on every request, server-side.** One call, resolved inside the
database — a client can never talk itself into an action:

```ts
// Supabase (server client, publishable key — RLS never blocks these reads,
// and every check runs inside the database)
const { data: allowed } = await supabase.rpc("has_permission_for_external", {
  _external_id: user.id, // auth.uid()
  _perm: "invoices.refund",
});
if (!allowed) throw new Error("Forbidden");
```

```ts
// Clerk (Next.js route handler / Server Action)
import { auth } from "@clerk/nextjs/server";
const { userId } = await auth();
const { data: allowed } = await supabase.rpc("has_permission_for_external", {
  _external_id: userId,
  _perm: "invoices.refund",
});
```

```ts
// WorkOS (middleware / API route)
import { withAuth } from "@workos-inc/authkit-nextjs";
const { user } = await withAuth();
const { data: allowed } = await supabase.rpc("has_permission_for_external", {
  _external_id: user.id,
  _perm: "invoices.refund",
});
```

**3. (Supabase users) Enforce in RLS directly.** Mirror the decision into
your own tables' policies instead of checking in application code:

```sql
create policy "authors can refund own invoices"
on public.invoices for update to authenticated
using (
  author_id = auth.uid()
  and public.has_permission_for_external(auth.uid()::text, 'invoices.refund')
);
```

Notes:

- Console accounts (this app's logins) are operators only — they never appear
  in the graph and need no mapping.
- Raw SQL works too: `select has_permission_for_external($1, $2)` over any
  Postgres connection with a restricted role.
- Rotate nothing on the Keyring side when you switch providers — just register
  the new provider's IDs as additional subjects (or update `external_id`).

## Management API (no dashboard required)

Every console action is also a REST call for backends that manage access
programmatically — grant roles, revoke them, change a user's access without
touching the UI.

**Auth: issued API keys — no service_role key exists anywhere in this stack.**
Create one in Settings → API keys (name it, copy it once — only the hash is
stored). Pass it as `Authorization: Bearer <key>`. Revoking kills it instantly
(`last_used_at` tells you if it's still in use). Server routes run over the
publishable key; every operation validates the issued key inside a
`SECURITY DEFINER` function (`0007_api_functions.sql`).

```sh
# Grant a role (auto-provisions the subject; idempotent)
curl -X POST "$KEYRING_URL/api/v1/grants" \
  -H "Authorization: Bearer $KEYRING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"role": "editor", "subject": "user_abc123"}'
# → {"ok": true, "role": "editor", "subject": "user_abc123"}

# Revoke it (idempotent)
curl -X DELETE "$KEYRING_URL/api/v1/grants" \
  -H "Authorization: Bearer $KEYRING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"role": "editor", "subject": "user_abc123"}'
# → {"ok": true, "revoked": true}

# Read check (prefers RPC? use this when REST is handier)
curl "$KEYRING_URL/api/v1/check?subject=user_abc123&permission=invoices.refund" \
  -H "Authorization: Bearer $KEYRING_API_KEY"
# → {"subject": "user_abc123", "permission": "invoices.refund", "allowed": true}

# Discover slugs programmatically (customer plane only — console roles
# and permissions never leak through these endpoints)
curl "$KEYRING_URL/api/v1/roles" -H "Authorization: Bearer $KEYRING_API_KEY"
curl "$KEYRING_URL/api/v1/permissions" -H "Authorization: Bearer $KEYRING_API_KEY"
```

```ts
// Same thing from Node, e.g. inside your signup webhook:
await fetch(`${process.env.KEYRING_URL}/api/v1/grants`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.KEYRING_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ role: "viewer", subject: newUser.id }),
});
```

To **change a user's access**, grant the new role and revoke the old one —
two calls, same audit trail as dashboard clicks (`grant.added` /
`grant.removed` land in the activity log either way).

## Database

Schema lives in `drizzle/migrations/` (`0000_rbac_core.sql`, `0001_organizations.sql`).
Apply new migrations in the Supabase dashboard SQL editor — the app cannot
migrate the hosted database itself. After applying, regenerate types if the
schema changed (`src/integrations/supabase/types.ts` is checked in).
