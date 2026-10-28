import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One guide, three homes: `keyring docs`, AGENTS.md block, .claude skill. */
export const AGENT_GUIDE = `# Keyring — authorization for this project

Keyring answers one question: **can subject X do action Y (in space Z)?**

- **Subject**: your app's end-user, by YOUR id (\`user_123\`). Created on first grant.
- **Action**: atomic permission, lowercase \`resource.verb\` (\`invoices.refund\`).
- **Role**: kebab-case bundle of actions (\`support-lead\`). Access = union of held roles.
- **Space**: optional isolated tenant (\`acme\`) with its own actions/roles/grants. Omit = platform scope. No inheritance between scopes.
- **Grant**: subject holds role, optionally with expiry (\`--ttl 3600\`) or an ABAC condition (\`{"attr":"plan","in":["pro"]}\`).

## Source of truth: \`keyring.policy.json\`

Edit this file to change actions/roles, then \`keyring push\`. Never hand-create roles in prod.

\`\`\`json
{
  "actions": { "invoices.read": "Read invoices", "invoices.refund": { "name": "Refund", "category": "Billing" } },
  "roles": { "viewer": ["invoices.read"], "finance": ["invoices.*"], "admin": ["*"] },
  "defaultRole": "viewer",
  "spaces": { "acme": { "actions": { … }, "roles": { … } } }
}
\`\`\`

## Commands (all support \`--json\`; JSON is automatic when stdout is not a TTY)

| Task | Command |
| --- | --- |
| Local sandbox + console (embedded Postgres, zero config) | \`keyring dev\` |
| Validate + preview policy changes | \`keyring push --dry-run\` |
| Apply policy | \`keyring push\` (\`--prune\` also deletes what the file dropped) |
| Typed slugs for TS | \`keyring generate\` → \`keyring.gen.ts\` |
| Is X allowed? (exit 0 yes / 1 no / 2 error) | \`keyring check user_123 invoices.refund [--space acme] [--context '{"plan":"pro"}']\` |
| Why? | \`keyring access user_123\` · \`keyring events --subject user_123\` |
| Grant / revoke | \`keyring grant finance user_123 [--ttl 3600]\` · \`keyring revoke finance user_123\` |
| Health of every link (env, DB, schema, key, drift) | \`keyring doctor\` |
| All commands, machine-readable | \`keyring commands --json\` |

Errors are \`{ "ok": false, "error": { "code", "message", "hint" } }\` — the \`hint\` is the next command to run.

## In application code

\`\`\`ts
// Your own Postgres (embedded — no hosted API in the path)
import { Pool } from "pg";
import { createKeyring } from "@usekeyring/sdk/postgres";
export const keyring = createKeyring({ database: new Pool({ connectionString: process.env.DATABASE_URL }), apiKey: process.env.KEYRING_SECRET_KEY! });

// Or hosted
import { Keyring } from "@usekeyring/sdk";
export const keyring = new Keyring({ apiKey: process.env.KEYRING_SECRET_KEY!, baseUrl: process.env.KEYRING_BASE_URL! });

await keyring.assert(user.id, "invoices.refund");          // throws ForbiddenError
const { allowed } = await keyring.check(user.id, "invoices.read", { space: org.slug });
await keyring.provisionSubject({ subject: user.id });       // on signup → defaultRole
\`\`\`

## Rules for agents

1. Change the model by editing \`keyring.policy.json\` + \`keyring push --dry-run\`, then \`keyring push\`. Show the user the dry-run plan before \`--prune\`.
2. Check server-side. Never trust a client-sent role; never cache \`allowed\` across requests.
3. Never print or commit \`KEYRING_SECRET_KEY\`. \`.keyring/\` (local DB + root key) is gitignored.
4. Debug a denial with \`keyring access <subject>\` before changing grants.
5. Prefer \`provisionSubject\` (default role) over hard-coding a role at signup.
`;

export const SKILL_MD = `---
name: keyring
description: Authorization (RBAC/ABAC) for this project via Keyring — use when adding permission checks, roles, actions, grants, multi-tenant spaces, or debugging "why can't this user do X". Covers keyring.policy.json, the keyring CLI and @usekeyring/sdk.
---

${AGENT_GUIDE}`;

const START = "<!-- keyring:start -->";
const END = "<!-- keyring:end -->";

/** Insert or refresh the managed block in AGENTS.md (other content untouched). */
export function writeAgentsBlock(cwd: string): "created" | "updated" | "unchanged" {
  const path = join(cwd, "AGENTS.md");
  const block = `${START}\n${AGENT_GUIDE.replace(/^# /, "## ")}${END}`;
  if (!existsSync(path)) {
    writeFileSync(path, `${block}\n`);
    return "created";
  }
  const current = readFileSync(path, "utf8");
  const re = new RegExp(`${START}[\\s\\S]*?${END}`);
  const next = re.test(current) ? current.replace(re, block) : `${current.trimEnd()}\n\n${block}\n`;
  if (next === current) return "unchanged";
  writeFileSync(path, next);
  return "updated";
}

export function writeSkill(cwd: string): "created" | "updated" | "unchanged" {
  const path = join(cwd, ".claude/skills/keyring/SKILL.md");
  return writeIfChanged(path, SKILL_MD);
}

function writeIfChanged(path: string, content: string): "created" | "updated" | "unchanged" {
  const exists = existsSync(path);
  if (exists && readFileSync(path, "utf8") === content) return "unchanged";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return exists ? "updated" : "created";
}

export const MCP_ENTRY = { command: "npx", args: ["-y", "@usekeyring/cli", "mcp"] };

/** Register the MCP server for Claude Code (.mcp.json), Cursor and VS Code when present. */
export function writeMcpConfigs(cwd: string): { file: string; status: string }[] {
  const out: { file: string; status: string }[] = [];
  const merge = (file: string, key: "mcpServers" | "servers") => {
    const path = join(cwd, file);
    let json: Record<string, Record<string, unknown>> = {};
    if (existsSync(path)) {
      try {
        json = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        out.push({ file, status: "skipped (invalid JSON)" });
        return;
      }
    }
    json[key] ??= {};
    if (json[key]["keyring"]) {
      out.push({ file, status: "unchanged" });
      return;
    }
    json[key]["keyring"] = key === "servers" ? { type: "stdio", ...MCP_ENTRY } : MCP_ENTRY;
    const existed = existsSync(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
    out.push({ file, status: existed ? "updated" : "created" });
  };
  merge(".mcp.json", "mcpServers");
  if (existsSync(join(cwd, ".cursor"))) merge(".cursor/mcp.json", "mcpServers");
  if (existsSync(join(cwd, ".vscode"))) merge(".vscode/mcp.json", "servers");
  return out;
}
