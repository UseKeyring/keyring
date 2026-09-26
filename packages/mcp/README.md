# @keyring/mcp

MCP server that lets AI agents manage Keyring access control: answer access
questions, explore roles and actions, grant/revoke roles, and mint subject
tokens. stdio transport — works with Claude Desktop, Cursor, VS Code and
opencode.

It wraps [`@usekeyring/sdk`](../sdk) and talks to the Keyring Management API
(`/api/v1`), so the agent gets exactly the permissions its API key carries.

## Requirements

- A **secret** API key (`kr_sk_live_…`, legacy `kr_live_…`) with the scopes
  the agent needs: `check`, `grants.write`, `roles.read`, `roles.write`,
  `actions.read`, `actions.write`, `subject_tokens.write`. Create one in
  Settings — publishable keys are rejected at startup. For key-first
  bootstrap (create actions/roles without the dashboard), the key needs
  `actions.write` + `roles.write`.
- `KEYRING_BASE_URL` — your Keyring app origin (`https://usekeyring.dev` for the hosted app).

## Run

```sh
bun install
bun --filter @keyring/mcp build
KEYRING_API_KEY=kr_sk_live_… KEYRING_BASE_URL=https://usekeyring.dev bun --filter @keyring/mcp start
```

## Connect your agent

Claude Desktop (`claude_desktop_config.json`), Cursor and VS Code
(`.vscode/mcp.json`) share the same shape:

```json
{
  "mcpServers": {
    "keyring": {
      "command": "node",
      "args": ["/absolute/path/to/keyring/packages/mcp/dist/index.js"],
      "env": {
        "KEYRING_API_KEY": "kr_sk_live_…",
        "KEYRING_BASE_URL": "https://usekeyring.dev"
      }
    }
  }
}
```

opencode (`opencode.json`):

```json
{
  "mcp": {
    "keyring": {
      "type": "local",
      "command": ["node", "/absolute/path/to/keyring/packages/mcp/dist/index.js"],
      "env": {
        "KEYRING_API_KEY": "kr_sk_live_…",
        "KEYRING_BASE_URL": "https://usekeyring.dev"
      }
    }
  }
}
```

Rebuild after pulling (`bun --filter @keyring/mcp build`) — clients run `dist/`.

## Tools

| Tool | What it does | Scope |
| ---- | ------------ | ----- |
| `check_access` | Is `subject` allowed `permission`? | `check` |
| `list_roles` | All roles in the active workspace | `roles.read` |
| `list_actions` | All actions in the active workspace | `actions.read` |
| `create_role` | Create/update a role, optionally attaching existing actions | `roles.write` |
| `create_action` | Create/update an action | `actions.write` |
| `grant_role` | Grant `role` to `subject` | `grants.write` |
| `revoke_role` | Revoke `role` from `subject` (marked destructive) | `grants.write` |
| `replace_role` | Grant `to`, then revoke `from` (marked destructive) | `grants.write` |
| `create_subject_token` | Mint a short-lived browser JWT for `subject` | `subject_tokens.write` |

Errors come back with the API status plus a hint (bad key on 401, missing
scope on 403). The agent only ever acts inside the key's active workspace.
