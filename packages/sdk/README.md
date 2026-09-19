# `@keyring/sdk`

TypeScript client for the Keyring Management API. Works on the **server** (secret key) and in the **browser** (publishable key + subject token).

## Install

```sh
bun add @keyring/sdk
# or: npm i @keyring/sdk
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
import { Keyring } from "@keyring/sdk";

const keyring = new Keyring({
  apiKey: process.env.KEYRING_SECRET_KEY!,
  baseUrl: process.env.KEYRING_URL!,
});

await keyring.grantRole({
  role: "viewer",
  subject: user.id,
  displayName: user.email,
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
import { Keyring } from "@keyring/sdk";

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

Typed errors: `UnauthorizedError`, `ForbiddenError`, `BadRequestError`, `NotFoundError`, `ApiError`, all extending `KeyringError` (`status`, `body`).
