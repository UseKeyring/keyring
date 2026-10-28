# `@usekeyring/cli`

Authorization you can run anywhere — with a CLI built for humans *and* agents.

```bash
npx @usekeyring/cli init   # keyring.policy.json, .gitignore, AGENTS.md, Claude skill, .mcp.json
npx @usekeyring/cli dev    # local Keyring (embedded Postgres) + console + /api/v1 on :4983
```

- **`keyring dev`**: zero-config local sandbox. It runs PGlite in `.keyring/`, auto-bootstraps a root key, pushes your policy file on every save, and serves the console plus a hosted-compatible `/api/v1`.
- **Policy as code**: `keyring push [--dry-run|--prune]`, `pull`, `generate` (typed slugs).
- **Your own Postgres**: `DATABASE_URL=… keyring migrate && keyring bootstrap`, then `createKeyring()` from `@usekeyring/sdk/postgres`.
- **Access**: `check` (exit 0 allowed / 1 denied), `grant --ttl`, `revoke`, `provision`, `attrs`, `access`, `events -f`.
- **Agents**: JSON whenever piped, `{ok:false,error:{code,message,hint}}` errors, `keyring commands --json`, `keyring docs`, `keyring mcp`.
- **Ops**: `keys create --scopes …`, `whoami`, `doctor`.

Full docs: https://usekeyring.dev/docs/cli · Agent guide: `keyring docs` or `/llms.txt`.
