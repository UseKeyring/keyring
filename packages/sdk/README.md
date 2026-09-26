# `@usekeyring/sdk`

TypeScript client for the Keyring Management API. Works on the **server** (secret key) and in the **browser** (publishable key + subject token).

## Install

```sh
bun add @usekeyring/sdk
# or: npm i @usekeyring/sdk
```

## Keys

| Kind | Prefix | Where | Can do |
|---|---|---|---|
| Secret | `kr_sk_live_…` (legacy `kr_live_…`) | Server env only | Any selected Management API scopes |
| Publishable | `kr_pk_live_…` | Frontend (`NEXT_PUBLIC_…`) | `check` only (with a subject token) |

Scopes are chosen when you create the key (Polar-style picker): `check`, `grants.write`, `roles.read`, `actions.read`, `subject_tokens.write`, `telemetry.read`, `telemetry.write`. Missing a scope → `403`.

Create keys in the Keyring console under **Settings → API keys**.

Browser checks are for **UX** (show/hide UI). Enforce access on your server with a secret key that includes `check`.

## Server

```ts
import { Keyring } from "@usekeyring/sdk";

const keyring = new Keyring({
  apiKey: process.env.KEYRING_SECRET_KEY!,
  baseUrl: process.env.KEYRING_URL!,
});

await keyring.grantRole({
  role: "viewer",
  subject: user.id,
  displayName: user.email,
});

// Temporary access — auto-expires, no revoke needed
// (e.g. let this token create repos for the next 5 minutes):
await keyring.grantRole({
  role: "repo-creator",
  subject: user.id,
  ttlSeconds: 300,
});

const { allowed } = await keyring.check(user.id, "invoices.refund");

// Manual telemetry event (checks auto-log; secret key needs telemetry.write):
await keyring.track(user.id, "invoices.refund", {
  context: { source: "refund-dialog" },
});

// After your own login (Clerk / Supabase / WorkOS / …), mint a token for the browser:
const { token, expiresAt } = await keyring.createSubjectToken({
  subject: user.id,
  ttlSeconds: 3600,
});
```

## Browser

```ts
import { Keyring } from "@usekeyring/sdk";

const keyring = new Keyring({
  apiKey: process.env.NEXT_PUBLIC_KEYRING_PUBLISHABLE_KEY!,
  baseUrl: process.env.NEXT_PUBLIC_KEYRING_URL!,
  subjectToken: () => readCookie("keyring_subject"),
});

const { allowed } = await keyring.check("invoices.refund");
```

Or pass the token per call:

```ts
await keyring.check("invoices.refund", { subjectToken });
```

## Subject tokens

1. User signs in with **your** auth provider.  
2. Your backend calls `createSubjectToken({ subject })` with the **secret** key.  
3. Return the JWT to the browser (prefer an httpOnly cookie).  
4. Frontend calls `check(permission)` with the **publishable** key + `X-Keyring-Subject-Token`.

The subject is taken from the JWT — the client cannot forge another subject id.

## Errors

Typed errors: `UnauthorizedError` (401 — bad/revoked key), `ForbiddenError`
(403 — missing scope, or `assert()` denial), `BadRequestError` (400),
`NotFoundError` (404), `ApiError` (anything else), all extending
`KeyringError` (`status`, `body`).

```ts
import { ForbiddenError, Keyring, UnauthorizedError } from "@usekeyring/sdk";

try {
  await keyring.assert(user.id, "invoices.refund");
} catch (err) {
  if (err instanceof UnauthorizedError) {
    // Key is invalid or revoked — check env vars.
  } else if (err instanceof ForbiddenError) {
    // Subject is not allowed (or key lacks the scope) — return 403.
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  throw err;
}
```

Publishable-key misuse (e.g. calling `grantRole()` with a `kr_pk_…` key)
throws a plain `Error` before any request is sent.

## API reference

All secret-key methods require a secret key (`kr_sk_…` / legacy `kr_live_…`)
and run on the server. Publishable keys (`kr_pk_…`) can only call `check()` /
`assert()` with a subject token.

| Method | Key | Description |
|---|---|---|
| `check(subject, permission, { context? })` | Secret | `GET /api/v1/check?subject=…&permission=…` |
| `check(permission, { subjectToken?, context? })` | Publishable | Subject comes from the JWT; `subject` query is never sent |
| `assert(…)` | Either (same signatures as `check`) | Returns the `CheckResult` when allowed, throws `ForbiddenError` otherwise |
| `grantRole({ role, subject, displayName?, expiresAt?, ttlSeconds?, condition? })` | Secret | `POST /api/v1/grants` — idempotent, auto-provisions the subject |
| `revokeRole({ role, subject })` | Secret | `DELETE /api/v1/grants` |
| `replaceRole({ subject, from, to, displayName?, expiresAt?, ttlSeconds?, condition? })` | Secret | Grant `to`, then revoke `from` |
| `listRoles()` | Secret | `GET /api/v1/roles` → `Role[]` |
| `listPermissions()` / `listActions()` (alias) | Secret | `GET /api/v1/permissions` → `Permission[]` |
| `createSubjectToken({ subject, ttlSeconds? })` | Secret | `POST /api/v1/subject-tokens` → `{ token, subject, expiresAt: Date }` |
| `setSubjectAttrs({ subject, attrs, displayName? })` | Secret | `POST /api/v1/subjects` — upsert (merge) attrs for ABAC conditions |
| `track(subject, permission, { allowed?, context? })` | Secret (`telemetry.write`) | `POST /api/v1/events` — manual telemetry; `check()` auto-logs |

### Checking with ABAC context

Request-time `context` rides along on `check()` and wins over stored subject
attrs when evaluating grant `condition`s:

```ts
// Grant gated on an attribute…
await keyring.grantRole({
  role: "pro-exporter",
  subject: user.id,
  condition: { attr: "plan", in: ["pro", "enterprise"] },
});

// …evaluated against stored attrs merged with per-request context.
await keyring.setSubjectAttrs({
  subject: user.id,
  attrs: { plan: "pro", region: "eu" },
});

const { allowed } = await keyring.check(user.id, "exports.run", {
  context: { plan: "pro" },
});
```

Conditions compose with `{ all: [...] }`, `{ any: [...] }`, `{ not: {...} }`.
Omit `condition` for an unconditional grant.

### Temporary access

`ttlSeconds` wins when both forms are given; omit both for a permanent grant.

```ts
await keyring.grantRole({
  role: "repo-creator",
  subject: user.id,
  ttlSeconds: 300, // expires 5 minutes from now
});

await keyring.grantRole({
  role: "contractor",
  subject: user.id,
  expiresAt: new Date("2026-12-31T00:00:00.000Z"), // or an ISO string
});
```

### Changing access

```ts
await keyring.revokeRole({ role: "viewer", subject: user.id });

// Atomic-ish swap: grant `to`, then revoke `from`.
// If the revoke fails after the grant, the subject may briefly hold both.
await keyring.replaceRole({ subject: user.id, from: "viewer", to: "editor" });

const roles = await keyring.listRoles();
const actions = await keyring.listActions(); // alias for listPermissions()
```

### `assert()` — throw on deny

Same overloads as `check()`; throws `ForbiddenError` when `allowed` is false:

```ts
// Server
await keyring.assert(user.id, "invoices.refund");

// Browser (publishable key + subject token)
await browser.assert("invoices.refund");
```

### Constructor options

```ts
const keyring = new Keyring({
  apiKey: process.env.KEYRING_SECRET_KEY!,
  baseUrl: process.env.KEYRING_URL!, // trailing slash is fine
  subjectToken: () => readCookie("keyring_subject"), // string | sync/async getter
  fetch: customFetch, // optional fetch override (tests, proxies)
  headers: { "X-Request-Id": requestId }, // extra headers on every request
});
```

`baseUrl` is the Keyring app origin (e.g. `https://app.example.com`).
`keyKind` (`"secret" | "publishable"`) is detected from the key prefix and
exposed as `keyring.keyKind`. `subjectToken` also accepts a plain string, and
any per-call `check(permission, { subjectToken })` overrides it.
