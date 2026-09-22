# Keyring — Access Controller Hub!

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

Backends (and browsers, for checks) manage access programmatically — grant
roles, revoke them, check permissions — without the dashboard.

**Auth: issued API keys — no service_role key exists anywhere in this stack.**
Create keys in Settings → API keys (copy once — only the hash is stored).

| Kind | Prefix | Use |
|---|---|---|
| **Secret** | `kr_sk_live_…` (legacy `kr_live_…`) | Server only — grant/revoke/list/check + mint subject tokens |
| **Publishable** | `kr_pk_live_…` | Frontend — `GET /api/v1/check` only, with `X-Keyring-Subject-Token` |

Pass the key as `Authorization: Bearer <key>`. Revoking kills it instantly.
Server routes run over the Supabase publishable key; every operation validates
the issued key inside a `SECURITY DEFINER` function. Subject-token JWTs are
signed with `SUBJECT_TOKEN_SECRET` on the Keyring app (see `.env.example`).

### TypeScript SDK (`@keyring/sdk`)

```ts
import { Keyring } from "@keyring/sdk";

// Server
const keyring = new Keyring({
  apiKey: process.env.KEYRING_SECRET_KEY!,
  baseUrl: process.env.KEYRING_URL!,
});

await keyring.grantRole({ role: "viewer", subject: newUser.id });
const { allowed } = await keyring.check(newUser.id, "invoices.refund");

// After your login, mint a token for the browser:
const { token } = await keyring.createSubjectToken({ subject: newUser.id });

// Browser (publishable key — UX checks only; enforce on the server too)
const browser = new Keyring({
  apiKey: process.env.NEXT_PUBLIC_KEYRING_PUBLISHABLE_KEY!,
  baseUrl: process.env.NEXT_PUBLIC_KEYRING_URL!,
  subjectToken: token,
});
await browser.check("invoices.refund");
```

Package lives at `packages/sdk`. See `packages/sdk/README.md`.

### curl

```sh
# Grant a role (secret key; auto-provisions the subject; idempotent)
curl -X POST "$KEYRING_URL/api/v1/grants" \
  -H "Authorization: Bearer $KEYRING_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"role": "editor", "subject": "user_abc123"}'

# Temporary access: role auto-expires (e.g. create repos for 5 minutes, then check() denies)
curl -X POST "$KEYRING_URL/api/v1/grants" \
  -H "Authorization: Bearer $KEYRING_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"role": "repo-creator", "subject": "user_abc123", "ttl_seconds": 300}'

# Mint a subject token for the browser (secret key)
curl -X POST "$KEYRING_URL/api/v1/subject-tokens" \
  -H "Authorization: Bearer $KEYRING_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"subject": "user_abc123", "ttl_seconds": 3600}'

# Browser check (publishable key + subject token)
curl "$KEYRING_URL/api/v1/check?permission=invoices.refund" \
  -H "Authorization: Bearer $KEYRING_PUBLISHABLE_KEY" \
  -H "X-Keyring-Subject-Token: $SUBJECT_TOKEN"

# Server check (secret key + subject query)
curl "$KEYRING_URL/api/v1/check?subject=user_abc123&permission=invoices.refund" \
  -H "Authorization: Bearer $KEYRING_SECRET_KEY"

curl "$KEYRING_URL/api/v1/roles" -H "Authorization: Bearer $KEYRING_SECRET_KEY"
curl "$KEYRING_URL/api/v1/permissions" -H "Authorization: Bearer $KEYRING_SECRET_KEY"
```

To **change a user's access**, grant the new role and revoke the old one
(or `keyring.replaceRole(...)`).

## Database

Schema lives in `drizzle/migrations/` (`0000_rbac_core.sql`, `0001_organizations.sql`).
Apply new migrations in the Supabase dashboard SQL editor — the app cannot
migrate the hosted database itself. After applying, regenerate types if the
schema changed (`src/integrations/supabase/types.ts` is checked in).

## Deploy (Cloudflare Workers)

Pushing to `main` auto-deploys via Workers Builds (build `cd apps/web &&
npx @opennextjs/cloudflare build`, deploy `cd apps/web &&
npx @opennextjs/cloudflare deploy`). Manual deploy from a checkout:

```bash
cd apps/web && bun run deploy
```

Build-time vars (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_WAITLIST`) are set in
the Cloudflare dashboard; `SUBJECT_TOKEN_SECRET` lives as a Worker secret
(`wrangler secret put SUBJECT_TOKEN_SECRET` from `apps/web`).
