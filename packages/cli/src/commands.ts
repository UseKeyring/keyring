/**
 * The command manifest — single source of truth for parsing, `--help`, and
 * `keyring commands --json` (so agents discover the exact same surface).
 */
export type OptSpec = { name: string; type: "string" | "boolean"; description: string; short?: string };
export type ArgSpec = { name: string; required?: boolean; description: string };
export type CommandSpec = {
  name: string;
  aliases?: string[];
  group: "Start" | "Model" | "Access" | "Inspect" | "Agents" | "Ops";
  summary: string;
  args?: ArgSpec[];
  options?: OptSpec[];
  examples: string[];
  /** Writes state (agents: confirm with the user or dry-run first). */
  mutates?: boolean;
  exitCodes?: Record<string, string>;
};

const space: OptSpec = { name: "space", type: "string", description: "Space slug (isolated tenant scope); omit for platform scope" };

export const GLOBAL_OPTIONS: OptSpec[] = [
  { name: "json", type: "boolean", description: "Machine-readable output (default when stdout is not a TTY)" },
  { name: "cwd", type: "string", description: "Project directory (default: current)" },
  { name: "key", type: "string", description: "API key (default: KEYRING_SECRET_KEY / KEYRING_API_KEY; local mode: .keyring root key)" },
  { name: "database-url", type: "string", description: "Postgres URL (default: KEYRING_DATABASE_URL / DATABASE_URL)" },
  { name: "base-url", type: "string", description: "Hosted API origin (default: KEYRING_BASE_URL)" },
  { name: "local", type: "boolean", description: "Force the embedded local database (.keyring/)" },
  { name: "help", type: "boolean", short: "h", description: "Show help" },
  { name: "version", type: "boolean", short: "v", description: "Print version" },
];

export const COMMANDS: CommandSpec[] = [
  {
    name: "init",
    group: "Start",
    summary: "Scaffold keyring.policy.json, .gitignore, AGENTS.md block, Claude skill and MCP config",
    options: [
      { name: "agents", type: "boolean", description: "Write AGENTS.md block + .claude/skills/keyring (default true; --no-agents to skip)" },
      { name: "mcp", type: "boolean", description: "Register the MCP server in .mcp.json / .cursor / .vscode (default true)" },
    ],
    examples: ["keyring init", "keyring init --no-mcp"],
    mutates: true,
  },
  {
    name: "dev",
    group: "Start",
    summary: "Local Keyring: embedded Postgres + console + /api/v1 on localhost; auto-pushes keyring.policy.json on save",
    options: [
      { name: "port", type: "string", description: "Port (default 4983, walks up if busy)" },
      { name: "open", type: "boolean", description: "Open the console in a browser (default: when interactive)" },
      { name: "watch", type: "boolean", description: "Re-push keyring.policy.json on change (default true)" },
      { name: "reset", type: "boolean", description: "Wipe the local database first (new root key)" },
    ],
    examples: ["keyring dev", "keyring dev --port 5000 --no-open", "keyring dev --reset"],
    mutates: true,
  },
  {
    name: "studio",
    aliases: ["console"],
    group: "Start",
    summary: "Open the console against the configured target (local, your DATABASE_URL, or hosted dashboard)",
    options: [
      { name: "port", type: "string", description: "Port (default 4983)" },
      { name: "open", type: "boolean", description: "Open a browser (default: when interactive)" },
    ],
    examples: ["keyring studio", "DATABASE_URL=postgres://… keyring studio"],
  },
  {
    name: "migrate",
    group: "Start",
    summary: "Install/upgrade the keyring schema (idempotent) in DATABASE_URL or the local DB",
    options: [{ name: "print", type: "boolean", description: "Print the SQL instead (for a SQL editor / migration tool)" }],
    examples: ["keyring migrate", "keyring migrate --print > supabase/migrations/0001_keyring.sql"],
    mutates: true,
  },
  {
    name: "bootstrap",
    group: "Start",
    summary: "Create a workspace + root secret key in DATABASE_URL (key shown once, saved to .env.local)",
    options: [
      { name: "slug", type: "string", description: "Workspace slug (default: package.json name)" },
      { name: "name", type: "string", description: "Display name" },
      { name: "env-file", type: "string", description: "Where to write KEYRING_SECRET_KEY (default .env.local; 'none' to skip)" },
    ],
    examples: ["keyring bootstrap --slug acme"],
    mutates: true,
  },
  {
    name: "push",
    group: "Model",
    summary: "Sync keyring.policy.json → database (validates, diffs, applies)",
    args: [{ name: "file", description: "Policy file (default keyring.policy.json)" }],
    options: [
      { name: "dry-run", type: "boolean", description: "Show the plan, change nothing" },
      { name: "prune", type: "boolean", description: "Also delete roles/actions/links not in the file (DB targets only)" },
      { name: "yes", type: "boolean", short: "y", description: "Confirm destructive ops (required with --prune deletes)" },
    ],
    examples: ["keyring push --dry-run", "keyring push", "keyring push --prune --yes"],
    mutates: true,
  },
  {
    name: "pull",
    group: "Model",
    summary: "Export the live model to keyring.policy.json (or stdout)",
    args: [{ name: "file", description: "Output file (default keyring.policy.json)" }],
    options: [
      { name: "stdout", type: "boolean", description: "Print instead of writing" },
      { name: "force", type: "boolean", description: "Overwrite an existing file that differs" },
    ],
    examples: ["keyring pull --stdout", "keyring pull --force"],
  },
  {
    name: "generate",
    group: "Model",
    summary: "Emit TypeScript slug types from the policy file (typos become compile errors)",
    args: [{ name: "file", description: "Policy file (default keyring.policy.json)" }],
    options: [{ name: "out", type: "string", description: "Output path (default keyring.gen.ts)" }],
    examples: ["keyring generate", "keyring generate --out src/lib/keyring.gen.ts"],
  },
  {
    name: "schema",
    group: "Model",
    summary: "Print the JSON Schema for keyring.policy.json",
    examples: ["keyring schema > keyring.policy.schema.json"],
  },
  {
    name: "check",
    group: "Access",
    summary: "Is SUBJECT allowed ACTION? Exit 0 allowed, 1 denied, 2 error",
    args: [
      { name: "subject", required: true, description: "Your user id" },
      { name: "action", required: true, description: "Action slug (resource.verb)" },
    ],
    options: [space, { name: "context", type: "string", description: "ABAC request context JSON, e.g. '{\"plan\":\"pro\"}'" }],
    examples: ["keyring check user_123 invoices.refund", "keyring check user_123 docs.edit --space acme --context '{\"plan\":\"pro\"}'"],
    exitCodes: { "0": "allowed", "1": "denied", "2": "error" },
  },
  {
    name: "grant",
    group: "Access",
    summary: "Grant ROLE to SUBJECT (idempotent; creates the subject)",
    args: [
      { name: "role", required: true, description: "Role slug" },
      { name: "subject", required: true, description: "Your user id" },
    ],
    options: [
      space,
      { name: "ttl", type: "string", description: "Temporary: seconds until expiry (30..31536000)" },
      { name: "expires", type: "string", description: "Temporary: ISO timestamp (max 1 year)" },
      { name: "condition", type: "string", description: "ABAC condition JSON, e.g. '{\"attr\":\"plan\",\"in\":[\"pro\"]}'" },
      { name: "display-name", type: "string", description: "Human label for the subject" },
    ],
    examples: ["keyring grant editor user_123", "keyring grant oncall user_123 --ttl 3600"],
    mutates: true,
  },
  {
    name: "revoke",
    group: "Access",
    summary: "Revoke ROLE from SUBJECT",
    args: [
      { name: "role", required: true, description: "Role slug" },
      { name: "subject", required: true, description: "Your user id" },
    ],
    options: [space],
    examples: ["keyring revoke editor user_123"],
    mutates: true,
  },
  {
    name: "provision",
    group: "Access",
    summary: "Give SUBJECT the scope's defaultRole (call on signup)",
    args: [{ name: "subject", required: true, description: "Your user id" }],
    options: [space, { name: "display-name", type: "string", description: "Human label" }],
    examples: ["keyring provision user_123"],
    mutates: true,
  },
  {
    name: "attrs",
    group: "Access",
    summary: "Merge ABAC attributes into SUBJECT",
    args: [
      { name: "subject", required: true, description: "Your user id" },
      { name: "json", required: true, description: "Attributes object, e.g. '{\"plan\":\"pro\"}'" },
    ],
    examples: ["keyring attrs user_123 '{\"plan\":\"pro\",\"region\":\"eu\"}'"],
    mutates: true,
  },
  {
    name: "access",
    group: "Inspect",
    summary: "Everything SUBJECT holds: roles, effective actions, grants (the 'why')",
    args: [{ name: "subject", required: true, description: "Your user id" }],
    options: [space],
    examples: ["keyring access user_123", "keyring access user_123 --space acme"],
  },
  { name: "roles", group: "Inspect", summary: "List roles (with their actions when the DB is reachable)", options: [space], examples: ["keyring roles", "keyring roles --space acme --json"] },
  { name: "actions", aliases: ["permissions"], group: "Inspect", summary: "List actions", options: [space], examples: ["keyring actions"] },
  { name: "spaces", group: "Inspect", summary: "List spaces", examples: ["keyring spaces"] },
  {
    name: "subjects",
    group: "Inspect",
    summary: "Search subjects (DB targets)",
    args: [{ name: "query", description: "Substring of id or display name" }],
    options: [{ name: "limit", type: "string", description: "Max rows (default 100)" }],
    examples: ["keyring subjects", "keyring subjects alice"],
  },
  {
    name: "events",
    group: "Inspect",
    summary: "Recent checks/decisions (DB targets); --follow to tail",
    options: [
      { name: "subject", type: "string", description: "Only this subject" },
      { name: "denied", type: "boolean", description: "Only denials" },
      { name: "limit", type: "string", description: "Rows (default 30)" },
      { name: "follow", type: "boolean", short: "f", description: "Stream new events" },
    ],
    examples: ["keyring events --denied", "keyring events -f"],
  },
  {
    name: "keys",
    group: "Ops",
    summary: "API keys: list | create | revoke <id|prefix|name>",
    args: [
      { name: "action", description: "list (default) | create | revoke" },
      { name: "id", description: "Key id, prefix or name (revoke)" },
    ],
    options: [
      { name: "name", type: "string", description: "Key name (create)" },
      { name: "scopes", type: "string", description: "Comma-separated scopes (create; default: all for secret, check for publishable)" },
      { name: "publishable", type: "boolean", description: "Browser key, check-only (create)" },
    ],
    examples: ["keyring keys", "keyring keys create --name api-server --scopes check,grants.write", "keyring keys revoke kr_sk_live_A"],
    mutates: true,
  },
  { name: "whoami", group: "Ops", summary: "Which target, workspace, key and scopes are in effect", examples: ["keyring whoami --json"] },
  { name: "doctor", group: "Ops", summary: "Check every link: env, DB, schema, key, scopes, policy drift — with fixes", examples: ["keyring doctor"] },
  { name: "mcp", group: "Agents", summary: "Run the Keyring MCP server over stdio (works against any target)", examples: ["keyring mcp", "claude mcp add keyring -- npx -y @usekeyring/cli mcp"] },
  { name: "docs", aliases: ["llms"], group: "Agents", summary: "Print the agent guide (markdown, same as llms.txt)", examples: ["keyring docs"] },
  { name: "commands", group: "Agents", summary: "This manifest as JSON — every command, arg, flag and exit code", examples: ["keyring commands --json"] },
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

export type Parsed = { command?: CommandSpec; positionals: string[]; opts: Record<string, string | boolean>; unknown: string[] };

export function parseArgv(argv: string[]): Parsed {
  // Command = first bare word, skipping values of global string flags (`--cwd /x dev`).
  let first = -1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (a.startsWith("-")) {
      if (!a.includes("=") && GLOBAL_OPTIONS.some((o) => o.type === "string" && `--${o.name}` === a)) i++;
      continue;
    }
    first = i;
    break;
  }
  const command = first >= 0 ? findCommand(argv[first]!) : undefined;
  const rest = first >= 0 && command ? [...argv.slice(0, first), ...argv.slice(first + 1)] : argv;
  const specs = [...GLOBAL_OPTIONS, ...(command?.options ?? [])];
  const opts: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const unknown: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      positionals.push(a);
      continue;
    }
    let name: string;
    let value: string | undefined;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      value = eq >= 0 ? a.slice(eq + 1) : undefined;
    } else {
      const s = specs.find((o) => o.short === a.slice(1));
      if (!s) {
        unknown.push(a);
        continue;
      }
      name = s.name;
    }
    let spec = specs.find((o) => o.name === name);
    if (!spec && name.startsWith("no-")) {
      spec = specs.find((o) => o.name === name.slice(3) && o.type === "boolean");
      if (spec) {
        opts[spec.name] = false;
        continue;
      }
    }
    if (!spec) {
      unknown.push(a);
      continue;
    }
    if (spec.type === "boolean") opts[spec.name] = value === undefined ? true : value !== "false";
    else {
      const v = value ?? rest[++i];
      if (v === undefined) unknown.push(`${a} (missing value)`);
      else opts[spec.name] = v;
    }
  }
  if (first >= 0 && !command) positionals.unshift(argv[first]!);
  return { command, positionals, opts, unknown };
}
