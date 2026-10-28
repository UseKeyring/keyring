import { existsSync, readFileSync } from "node:fs";
import { CliError } from "./output.js";
import type { AdminApi, Api } from "./target.js";

/**
 * keyring.policy.json — the access model as code (like a Better Auth config,
 * but for authorization). Map form so diffs stay one-line-per-change:
 *
 *   {
 *     "actions": { "invoices.read": "Read invoices",
 *                  "invoices.refund": { "name": "Refund", "category": "Billing" } },
 *     "roles":   { "viewer": ["invoices.read"],
 *                  "finance": { "name": "Finance", "actions": ["invoices.*"] } },
 *     "defaultRole": "viewer",
 *     "spaces":  { "acme": { "name": "Acme", "actions": {…}, "roles": {…} } }
 *   }
 */
export type ActionSpec = string | { name: string; category?: string; description?: string };
export type RoleSpec = string[] | { name?: string; description?: string; actions?: string[] };
export type ScopeSpec = {
  actions?: Record<string, ActionSpec>;
  roles?: Record<string, RoleSpec>;
  defaultRole?: string | null;
};
export type PolicyFile = ScopeSpec & {
  $schema?: string;
  spaces?: Record<string, ScopeSpec & { name?: string; description?: string }>;
};

export type NormAction = { slug: string; name: string; category: string; description: string | null };
export type NormRole = { slug: string; name: string; description: string | null; actions: string[] };
export type NormScope = {
  space: string | null;
  spaceName?: string;
  spaceDescription?: string | null;
  actions: NormAction[];
  roles: NormRole[];
  defaultRole: string | null | undefined;
};

export const POLICY_FILE = "keyring.policy.json";
export const POLICY_SCHEMA_URL = "https://usekeyring.dev/schema/policy.json";
const ACTION_RE = /^[a-z0-9]+[a-z0-9._-]*\.[a-z0-9._-]+$/;
const ROLE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function readPolicy(path: string): PolicyFile {
  if (!existsSync(path)) {
    throw new CliError(`No policy file at ${path}`, "policy_not_found", "Create one with `keyring init`, or export the live model with `keyring pull`.");
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PolicyFile;
  } catch (err) {
    throw new CliError(`${path} is not valid JSON: ${(err as Error).message}`, "policy_invalid_json");
  }
}

const titleCase = (slug: string) =>
  slug
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");

/** Validate + normalize; every problem is reported with its JSON path. */
export function normalizePolicy(policy: PolicyFile): NormScope[] {
  const problems: string[] = [];
  const scope = (spec: ScopeSpec, space: string | null, at: string): NormScope => {
    const actions: NormAction[] = [];
    for (const [slug, raw] of Object.entries(spec.actions ?? {})) {
      if (!ACTION_RE.test(slug)) problems.push(`${at}.actions["${slug}"]: action slugs are lowercase resource.verb (e.g. invoices.refund)`);
      const a = typeof raw === "string" ? { name: raw } : raw;
      if (!a || typeof a.name !== "string" || !a.name.trim()) {
        problems.push(`${at}.actions["${slug}"]: needs a name (string or { "name": … })`);
        continue;
      }
      actions.push({ slug, name: a.name.trim(), category: a.category?.trim() || "General", description: a.description?.trim() || null });
    }
    const declared = actions.map((a) => a.slug);
    const expand = (pattern: string, roleAt: string): string[] => {
      if (pattern === "*") return declared;
      if (pattern.endsWith(".*")) {
        const prefix = pattern.slice(0, -1);
        const hits = declared.filter((s) => s.startsWith(prefix));
        if (hits.length === 0) problems.push(`${roleAt}: "${pattern}" matches no declared action`);
        return hits;
      }
      if (!declared.includes(pattern)) problems.push(`${roleAt}: unknown action "${pattern}" — declare it under ${at}.actions`);
      return [pattern];
    };
    const roles: NormRole[] = [];
    for (const [slug, raw] of Object.entries(spec.roles ?? {})) {
      const roleAt = `${at}.roles["${slug}"]`;
      if (!ROLE_RE.test(slug)) problems.push(`${roleAt}: role slugs are kebab-case (e.g. support-lead)`);
      const r = Array.isArray(raw) ? { actions: raw } : (raw ?? {});
      const acts = [...new Set((r.actions ?? []).flatMap((p) => expand(p, roleAt)))].sort();
      roles.push({ slug, name: r.name?.trim() || titleCase(slug), description: r.description?.trim() || null, actions: acts });
    }
    if (spec.defaultRole && !roles.some((r) => r.slug === spec.defaultRole)) {
      problems.push(`${at}.defaultRole: "${spec.defaultRole}" is not a role in this scope`);
    }
    return { space, actions, roles, defaultRole: spec.defaultRole };
  };

  const out = [scope(policy, null, "$")];
  for (const [slug, sp] of Object.entries(policy.spaces ?? {})) {
    if (!ROLE_RE.test(slug)) problems.push(`$.spaces["${slug}"]: space slugs are kebab-case`);
    out.push({ ...scope(sp, slug, `$.spaces["${slug}"]`), spaceName: sp.name?.trim() || titleCase(slug), spaceDescription: sp.description ?? null });
  }
  if (problems.length) {
    throw new CliError(`Policy has ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`, "policy_invalid", "Fix the paths above; `keyring push --dry-run` re-validates without writing.");
  }
  return out;
}

export type Op =
  | { op: "create" | "update"; kind: "space" | "action" | "role"; space: string | null; slug: string; detail?: string }
  | { op: "link" | "unlink"; kind: "role_action"; space: string | null; slug: string; action: string }
  | { op: "delete"; kind: "action" | "role"; space: string | null; slug: string }
  | { op: "set_default"; kind: "default_role"; space: string | null; slug: string | null };

type LiveRole = { slug: string; name: string; description: string | null; actions?: string[]; is_default?: boolean };

type Live = {
  spaces: Map<string, { name: string; description: string | null }>;
  scopes: Map<string | null, { actions: Map<string, NormAction>; roles: Map<string, NormRole & { is_default?: boolean }>; linksKnown: boolean }>;
};

async function readLive(keyring: Api, admin: AdminApi | null, spaces: (string | null)[]): Promise<Live> {
  const liveSpaces = await keyring.listSpaces().catch(() => []);
  const live: Live = { spaces: new Map(liveSpaces.map((s) => [s.slug, { name: s.name, description: s.description }])), scopes: new Map() };
  for (const space of spaces) {
    if (space && !live.spaces.has(space)) {
      live.scopes.set(space, { actions: new Map(), roles: new Map(), linksKnown: true });
      continue;
    }
    const actions = await keyring.listPermissions(space ?? undefined);
    const roles: LiveRole[] = admin ? await admin.roleDetails(space) : await keyring.listRoles(space ?? undefined);
    live.scopes.set(space, {
      actions: new Map(actions.map((a) => [a.slug, { slug: a.slug, name: a.name, category: a.category, description: a.description }])),
      roles: new Map(
        roles.map((r) => [
          r.slug,
          {
            slug: r.slug,
            name: r.name,
            description: r.description ?? null,
            actions: r.actions ?? [],
            is_default: "is_default" in r ? (r.is_default as boolean) : undefined,
          },
        ]),
      ),
      linksKnown: admin != null,
    });
  }
  return live;
}

/** Diff desired vs live. Additive unless `prune` (which needs DB access). */
export async function planPolicy(scopes: NormScope[], keyring: Api, admin: AdminApi | null, prune: boolean): Promise<{ ops: Op[]; warnings: string[] }> {
  const live = await readLive(keyring, admin, scopes.map((s) => s.space));
  const ops: Op[] = [];
  const warnings: string[] = [];
  for (const s of scopes) {
    if (s.space) {
      const cur = live.spaces.get(s.space);
      if (!cur) ops.push({ op: "create", kind: "space", space: null, slug: s.space });
      else if (cur.name !== s.spaceName || (cur.description ?? null) !== (s.spaceDescription ?? null)) ops.push({ op: "update", kind: "space", space: null, slug: s.space });
    }
    const L = live.scopes.get(s.space)!;
    for (const a of s.actions) {
      const cur = L.actions.get(a.slug);
      if (!cur) ops.push({ op: "create", kind: "action", space: s.space, slug: a.slug });
      else if (cur.name !== a.name || cur.category !== a.category || (cur.description ?? null) !== a.description) {
        ops.push({ op: "update", kind: "action", space: s.space, slug: a.slug });
      }
    }
    for (const r of s.roles) {
      const cur = L.roles.get(r.slug);
      if (!cur) {
        ops.push({ op: "create", kind: "role", space: s.space, slug: r.slug, detail: r.actions.join(", ") });
        continue;
      }
      if (cur.name !== r.name || (cur.description ?? null) !== r.description) ops.push({ op: "update", kind: "role", space: s.space, slug: r.slug });
      if (!L.linksKnown) {
        if (r.actions.length) ops.push({ op: "update", kind: "role", space: s.space, slug: r.slug, detail: "re-assert actions (links not readable over hosted API)" });
        continue;
      }
      for (const act of r.actions) if (!cur.actions.includes(act)) ops.push({ op: "link", kind: "role_action", space: s.space, slug: r.slug, action: act });
      for (const act of cur.actions) {
        if (!r.actions.includes(act)) {
          if (prune) ops.push({ op: "unlink", kind: "role_action", space: s.space, slug: r.slug, action: act });
          else warnings.push(`role ${r.slug}${s.space ? `@${s.space}` : ""} also has ${act} (not in file; --prune removes)`);
        }
      }
    }
    for (const slug of L.roles.keys()) {
      if (!s.roles.some((r) => r.slug === slug)) {
        if (prune) ops.push({ op: "delete", kind: "role", space: s.space, slug });
        else warnings.push(`role ${slug}${s.space ? `@${s.space}` : ""} exists live but not in file (--prune deletes it and its grants)`);
      }
    }
    for (const slug of L.actions.keys()) {
      if (!s.actions.some((a) => a.slug === slug)) {
        if (prune) ops.push({ op: "delete", kind: "action", space: s.space, slug });
        else warnings.push(`action ${slug}${s.space ? `@${s.space}` : ""} exists live but not in file`);
      }
    }
    if (s.defaultRole !== undefined) {
      const curDefault = [...L.roles.values()].find((r) => r.is_default)?.slug ?? null;
      if (!L.linksKnown) warnings.push("defaultRole is skipped against the hosted API — set it in the web console");
      else if (curDefault !== (s.defaultRole ?? null)) ops.push({ op: "set_default", kind: "default_role", space: s.space, slug: s.defaultRole ?? null });
    }
  }
  if (prune && !admin) throw new CliError("--prune needs direct database access", "prune_unsupported", "Run against DATABASE_URL or the local dev database.");
  return { ops, warnings };
}

export async function applyPlan(scopes: NormScope[], ops: Op[], keyring: Api, admin: AdminApi | null): Promise<void> {
  const find = (space: string | null) => scopes.find((s) => s.space === space)!;
  const sp = (space: string | null) => space ?? undefined;
  // Order matters: spaces → actions → roles/links → prunes → defaults.
  for (const o of ops) {
    if (o.kind !== "space") continue;
    const s = find(o.slug);
    await keyring.createSpace({ slug: o.slug, name: s.spaceName!, description: s.spaceDescription ?? undefined });
  }
  for (const o of ops.filter((o) => o.kind === "action" && o.op !== "delete")) {
    const a = find(o.space).actions.find((x) => x.slug === o.slug)!;
    await keyring.createPermission({ slug: a.slug, name: a.name, category: a.category, description: a.description ?? undefined, space: sp(o.space) });
  }
  const touched = new Set<string>();
  for (const o of ops) {
    if (!((o.kind === "role" && o.op !== "delete") || o.op === "link")) continue;
    const id = `${o.space ?? ""}/${o.slug}`;
    if (touched.has(id)) continue;
    touched.add(id);
    const r = find(o.space).roles.find((x) => x.slug === o.slug)!;
    await keyring.createRole({ slug: r.slug, name: r.name, description: r.description ?? undefined, permissions: r.actions, space: sp(o.space) });
  }
  for (const o of ops) {
    if (o.op === "unlink") await admin!.unlinkAction(o.slug, o.action, o.space);
    if (o.op === "delete" && o.kind === "role") await admin!.deleteRole(o.slug, o.space);
  }
  for (const o of ops) if (o.op === "delete" && o.kind === "action") await admin!.deleteAction(o.slug, o.space);
  for (const o of ops) if (o.op === "set_default") await admin!.setDefaultRole(o.slug, o.space);
}

/** Export the live model as a policy file. */
export async function pullPolicy(keyring: Api, admin: AdminApi | null): Promise<{ policy: PolicyFile; warnings: string[] }> {
  const warnings: string[] = [];
  if (!admin) warnings.push("Role → action links are not readable over the hosted API; roles were exported without actions.");
  const scopeOf = async (space: string | null): Promise<ScopeSpec> => {
    const actions = await keyring.listPermissions(space ?? undefined);
    const roles: LiveRole[] = admin ? await admin.roleDetails(space) : await keyring.listRoles(space ?? undefined);
    const out: ScopeSpec = {
      actions: Object.fromEntries(
        actions.map((a) => [
          a.slug,
          a.category === "General" && !a.description ? a.name : { name: a.name, ...(a.category !== "General" ? { category: a.category } : {}), ...(a.description ? { description: a.description } : {}) },
        ]),
      ),
      roles: Object.fromEntries(
        roles.map((r) => {
          const acts = r.actions ?? [];
          const simple = r.name === titleCase(r.slug) && !r.description;
          return [r.slug, simple ? acts : { name: r.name, ...(r.description ? { description: r.description } : {}), actions: acts }];
        }),
      ),
    };
    const def = roles.find((r) => r.is_default);
    if (def) out.defaultRole = def.slug;
    return out;
  };
  const policy: PolicyFile = { $schema: POLICY_SCHEMA_URL, ...(await scopeOf(null)) };
  const spaces = await keyring.listSpaces().catch(() => []);
  if (spaces.length) {
    policy.spaces = {};
    for (const s of spaces) {
      policy.spaces[s.slug] = { name: s.name, ...(s.description ? { description: s.description } : {}), ...(await scopeOf(s.slug)) };
    }
  }
  return { policy, warnings };
}

export const STARTER_POLICY: PolicyFile = {
  $schema: POLICY_SCHEMA_URL,
  actions: {
    "projects.read": "View projects",
    "projects.write": "Create and edit projects",
    "projects.delete": { name: "Delete projects", category: "Danger" },
    "billing.manage": { name: "Manage billing", category: "Billing" },
  },
  roles: {
    viewer: ["projects.read"],
    editor: ["projects.read", "projects.write"],
    admin: { name: "Admin", description: "Everything", actions: ["*"] },
  },
  defaultRole: "viewer",
};

/** `keyring generate` — typed slugs so `check("u", "projcts.read")` fails to compile. */
export function generateTypes(scopes: NormScope[]): string {
  const union = (xs: string[]) => (xs.length ? xs.map((x) => JSON.stringify(x)).join(" | ") : "never");
  const platform = scopes.find((s) => s.space === null)!;
  const spaces = scopes.filter((s) => s.space !== null);
  const lines = [
    "// Generated by `keyring generate` from keyring.policy.json — do not edit.",
    "",
    `export const actions = ${JSON.stringify(platform.actions.map((a) => a.slug))} as const;`,
    `export const roles = ${JSON.stringify(platform.roles.map((r) => r.slug))} as const;`,
    "export type Action = (typeof actions)[number];",
    "export type Role = (typeof roles)[number];",
    "",
    `export type Space = ${union(spaces.map((s) => s.space!))};`,
    "export type SpaceActions = {",
    ...spaces.map((s) => `  ${JSON.stringify(s.space)}: ${union(s.actions.map((a) => a.slug))};`),
    "};",
    "export type SpaceRoles = {",
    ...spaces.map((s) => `  ${JSON.stringify(s.space)}: ${union(s.roles.map((r) => r.slug))};`),
    "};",
    "",
    "/** Which roles grant each platform action — handy for UI hints and tests. */",
    "export const grantedBy: Record<Action, readonly Role[]> = {",
    ...platform.actions.map((a) => `  ${JSON.stringify(a.slug)}: ${JSON.stringify(platform.roles.filter((r) => r.actions.includes(a.slug)).map((r) => r.slug))},`),
    "};",
    "",
  ];
  return lines.join("\n");
}

export const POLICY_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: POLICY_SCHEMA_URL,
  title: "Keyring policy",
  description: "Access model as code: actions (resource.verb), roles (bundles of actions), optional spaces (isolated tenants). Apply with `keyring push`.",
  type: "object",
  $defs: {
    action: {
      oneOf: [
        { type: "string", description: "Display name" },
        { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string" }, category: { type: "string" }, description: { type: "string" } } },
      ],
    },
    role: {
      oneOf: [
        { type: "array", items: { type: "string" }, description: "Action slugs; supports `resource.*` and `*`" },
        {
          type: "object",
          additionalProperties: false,
          properties: { name: { type: "string" }, description: { type: "string" }, actions: { type: "array", items: { type: "string" } } },
        },
      ],
    },
    scope: {
      type: "object",
      properties: {
        actions: { type: "object", propertyNames: { pattern: ACTION_RE.source }, additionalProperties: { $ref: "#/$defs/action" } },
        roles: { type: "object", propertyNames: { pattern: ROLE_RE.source }, additionalProperties: { $ref: "#/$defs/role" } },
        defaultRole: { type: ["string", "null"], description: "Role `provisionSubject` assigns in this scope" },
      },
    },
  },
  allOf: [{ $ref: "#/$defs/scope" }],
  properties: {
    $schema: { type: "string" },
    spaces: {
      type: "object",
      propertyNames: { pattern: ROLE_RE.source },
      additionalProperties: { allOf: [{ $ref: "#/$defs/scope" }], properties: { name: { type: "string" }, description: { type: "string" } } },
    },
  },
};
