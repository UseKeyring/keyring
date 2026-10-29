import { BadRequestError } from "../errors.js";

/**
 * `keyring.policy.json` — the access model as code. Identical format to the
 * CLI (`keyring push`), so one file drives local mode, Postgres and hosted:
 *
 *   {
 *     "actions": { "invoices.read": "Read invoices",
 *                  "invoices.refund": { "name": "Refund", "category": "Billing" } },
 *     "roles":   { "viewer": ["invoices.read"],
 *                  "finance": { "name": "Finance", "actions": ["invoices.*"] } },
 *     "defaultRole": "viewer",
 *     "spaces":  { "acme": { "name": "Acme", "actions": {…}, "roles": {…} } }
 *   }
 *
 * Role action lists accept exact slugs, `resource.*` and `*` (expanded against
 * the actions declared in the SAME scope — spaces never inherit).
 */
export type ActionSpec =
  | string
  | { readonly name: string; readonly category?: string; readonly description?: string };
export type RoleSpec =
  | readonly string[]
  | { readonly name?: string; readonly description?: string; readonly actions?: readonly string[] };
export type ScopeSpec = {
  readonly actions?: { readonly [slug: string]: ActionSpec };
  readonly roles?: { readonly [slug: string]: RoleSpec };
  readonly defaultRole?: string | null;
};
export type SpaceSpec = ScopeSpec & { readonly name?: string; readonly description?: string };
export type KeyringPolicy = ScopeSpec & {
  readonly $schema?: string;
  readonly spaces?: { readonly [slug: string]: SpaceSpec };
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

/** Same regexes as `drizzle/native.sql` and the CLI. */
export const ACTION_SLUG_RE = /^[a-z0-9]+[a-z0-9._-]*\.[a-z0-9._-]+$/;
export const ROLE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const titleCase = (slug: string) =>
  slug
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");

/**
 * Validate + normalize a policy (byte-for-byte the CLI's `normalizePolicy`).
 * Every problem is reported with its JSON path; throws `BadRequestError`
 * with `body.code = "policy_invalid"`.
 */
export function normalizePolicy(policy: KeyringPolicy): NormScope[] {
  const problems: string[] = [];
  const scope = (spec: ScopeSpec, space: string | null, at: string): NormScope => {
    const actions: NormAction[] = [];
    for (const [slug, raw] of Object.entries(spec.actions ?? {})) {
      if (!ACTION_SLUG_RE.test(slug)) problems.push(`${at}.actions["${slug}"]: action slugs are lowercase resource.verb (e.g. invoices.refund)`);
      const a = typeof raw === "string" ? { name: raw } : raw;
      if (!a || typeof a.name !== "string" || !a.name.trim()) {
        problems.push(`${at}.actions["${slug}"]: needs a name (string or { "name": … })`);
        continue;
      }
      const ext = a as { category?: string; description?: string };
      actions.push({ slug, name: a.name.trim(), category: ext.category?.trim() || "General", description: ext.description?.trim() || null });
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
      if (!ROLE_SLUG_RE.test(slug)) problems.push(`${roleAt}: role slugs are kebab-case (e.g. support-lead)`);
      const r: { name?: string; description?: string; actions?: readonly string[] } = isStringArray(raw) ? { actions: raw } : ((raw as object | null) ?? {});
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
    if (!ROLE_SLUG_RE.test(slug)) problems.push(`$.spaces["${slug}"]: space slugs are kebab-case`);
    out.push({ ...scope(sp, slug, `$.spaces["${slug}"]`), spaceName: sp.name?.trim() || titleCase(slug), spaceDescription: sp.description ?? null });
  }
  if (problems.length) {
    throw new BadRequestError(`Policy has ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`, {
      error: `Policy has ${problems.length} problem(s)`,
      code: "policy_invalid",
    });
  }
  return out;
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v);
}

/** Identity helper that keeps literal slugs for inference (alternative to `satisfies`). */
export function definePolicy<const P extends KeyringPolicy>(policy: P): P {
  return policy;
}

// ── Type-level inference ────────────────────────────────────────────────
//
// With a literal policy (`definePolicy({...})`, `{...} as const satisfies
// KeyringPolicy`, or a JSON import — TS keeps object keys literal), slugs
// become unions so typos fail to compile. A policy typed as plain
// `KeyringPolicy` (dynamic models) degrades every slug to `string`.

type Keys<T> = [T] extends [undefined] ? never : keyof NonNullable<T> & string;
type SpacesOf<P> = P extends { readonly spaces?: infer S } ? NonNullable<S> : never;

/** Space slugs declared by the policy. */
export type SpaceOf<P> = Keys<P extends { readonly spaces?: infer S } ? S : undefined>;

/** The scope object for platform (`S = undefined`) or a space. */
type ScopeFor<P, S> = [S] extends [undefined]
  ? P
  : S extends keyof SpacesOf<P>
    ? SpacesOf<P>[S]
    : never;

/** Action slugs of one scope (platform by default). Wildcards never appear. */
export type ActionOf<P, S extends string | undefined = undefined> = Keys<ScopeFor<P, S> extends { readonly actions?: infer A } ? A : undefined>;
/** Role slugs of one scope (platform by default). */
export type RoleOf<P, S extends string | undefined = undefined> = Keys<ScopeFor<P, S> extends { readonly roles?: infer R } ? R : undefined>;
