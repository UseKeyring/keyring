import { PostgresKeyring } from "@usekeyring/sdk/postgres";
import type { Database } from "./db.js";
import { generateApiKey } from "./env.js";
import { CliError } from "./output.js";

export type RoleDetail = {
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  actions: string[];
  holders: number;
  is_default: boolean;
};

export type SubjectGrant = { role: string; space: string | null; expires_at: string | null; condition: Record<string, unknown>; created_at: string; expired: boolean };
export type SubjectDetail = { subject: string; display_name: string | null; attrs: Record<string, unknown>; created_at: string; grants: SubjectGrant[] };

export const ALL_SCOPES = [
  "check",
  "grants.write",
  "roles.read",
  "roles.write",
  "spaces.read",
  "spaces.write",
  "actions.read",
  "actions.write",
  "subject_tokens.write",
  "telemetry.read",
  "telemetry.write",
  "webhooks.read",
  "webhooks.write",
  "integrations.write",
] as const;

/**
 * Operator surface that the key-authed RPCs don't expose (listing subjects,
 * grants, events, keys; deletes for `push --prune`). Runs as the DB owner,
 * but every statement is pinned to the workspace of the configured key —
 * the key is still the boundary, the DB connection is just the transport.
 */
export class Admin {
  private orgPromise?: Promise<{ id: string; slug: string; name: string }>;

  constructor(
    private readonly db: Database,
    private readonly keyring: PostgresKeyring,
  ) {}

  org(): Promise<{ id: string; slug: string; name: string }> {
    this.orgPromise ??= (async () => {
      const me = await this.keyring.whoami();
      const { rows } = await this.db.query("SELECT id, slug, name FROM keyring.organizations WHERE id = $1", [me.organization_id]);
      if (!rows[0]) throw new CliError("Workspace for this key no longer exists", "unknown_organization");
      return rows[0] as { id: string; slug: string; name: string };
    })();
    return this.orgPromise;
  }

  private async spaceId(space?: string | null): Promise<string | null> {
    if (!space) return null;
    const org = await this.org();
    const { rows } = await this.db.query("SELECT id FROM keyring.spaces WHERE organization_id = $1 AND slug = $2", [org.id, space]);
    if (!rows[0]) throw new CliError(`Unknown space: ${space}`, "unknown_space", "List spaces with `keyring spaces`.");
    return rows[0]["id"] as string;
  }

  async overview() {
    const org = await this.org();
    const { rows } = await this.db.query(
      `SELECT
        (SELECT count(*) FROM keyring.roles WHERE organization_id = $1 AND scope = 'customer')::int AS roles,
        (SELECT count(*) FROM keyring.permissions WHERE organization_id = $1 AND scope = 'customer')::int AS actions,
        (SELECT count(*) FROM keyring.subjects WHERE organization_id = $1)::int AS subjects,
        (SELECT count(*) FROM keyring.grants WHERE organization_id = $1 AND (expires_at IS NULL OR expires_at > now()))::int AS grants,
        (SELECT count(*) FROM keyring.spaces WHERE organization_id = $1)::int AS spaces,
        (SELECT count(*) FROM keyring.api_keys WHERE organization_id = $1 AND revoked_at IS NULL)::int AS keys,
        (SELECT count(*) FROM keyring.check_events WHERE organization_id = $1 AND created_at > now() - interval '24 hours')::int AS checks_24h,
        (SELECT count(*) FROM keyring.check_events WHERE organization_id = $1 AND created_at > now() - interval '24 hours' AND NOT allowed)::int AS denied_24h`,
      [org.id],
    );
    return { workspace: org, counts: rows[0] };
  }

  /** Roles with their action slugs — the piece `listRoles` can't give. */
  async roleDetails(space?: string | null): Promise<RoleDetail[]> {
    const org = await this.org();
    const sid = await this.spaceId(space);
    const { rows } = await this.db.query(
      `SELECT r.slug, r.name, r.description, r.created_at,
         COALESCE(array_agg(p.slug ORDER BY p.slug) FILTER (WHERE p.slug IS NOT NULL), '{}') AS actions,
         (SELECT count(*) FROM keyring.grants g WHERE g.role_id = r.id AND (g.expires_at IS NULL OR g.expires_at > now()))::int AS holders,
         (r.id = COALESCE((SELECT default_role_id FROM keyring.spaces WHERE id = $2), CASE WHEN $2::uuid IS NULL THEN (SELECT default_role_id FROM keyring.organizations WHERE id = $1) END)) AS is_default
       FROM keyring.roles r
       LEFT JOIN keyring.role_permissions rp ON rp.role_id = r.id
       LEFT JOIN keyring.permissions p ON p.id = rp.permission_id
       WHERE r.organization_id = $1 AND r.scope = 'customer' AND r.space_id IS NOT DISTINCT FROM $2::uuid
       GROUP BY r.id ORDER BY r.created_at`,
      [org.id, sid],
    );
    return rows.map((r) => ({ ...r, is_default: r["is_default"] === true }) as RoleDetail);
  }

  async listSubjects(opts: { q?: string; limit?: number } = {}) {
    const org = await this.org();
    const { rows } = await this.db.query(
      `SELECT s.external_id AS subject, s.display_name, s.attrs, s.created_at,
         COALESCE((SELECT array_agg(DISTINCT r.slug || COALESCE('@' || sp.slug, '')) FROM keyring.grants g
           JOIN keyring.roles r ON r.id = g.role_id LEFT JOIN keyring.spaces sp ON sp.id = g.space_id
           WHERE g.subject_id = s.id AND (g.expires_at IS NULL OR g.expires_at > now())), '{}') AS roles
       FROM keyring.subjects s
       WHERE s.organization_id = $1 AND ($2::text IS NULL OR s.external_id ILIKE '%' || $2 || '%' OR s.display_name ILIKE '%' || $2 || '%')
       ORDER BY s.created_at DESC LIMIT $3`,
      [org.id, opts.q || null, Math.min(opts.limit ?? 100, 1000)],
    );
    return rows;
  }

  async subject(external: string): Promise<SubjectDetail | null> {
    const org = await this.org();
    const { rows } = await this.db.query(
      "SELECT id, external_id AS subject, display_name, attrs, created_at FROM keyring.subjects WHERE organization_id = $1 AND external_id = $2",
      [org.id, external],
    );
    const s = rows[0];
    if (!s) return null;
    const grants = await this.db.query(
      `SELECT r.slug AS role, sp.slug AS space, g.expires_at, g.condition, g.created_at,
         (g.expires_at IS NOT NULL AND g.expires_at <= now()) AS expired
       FROM keyring.grants g JOIN keyring.roles r ON r.id = g.role_id LEFT JOIN keyring.spaces sp ON sp.id = g.space_id
       WHERE g.subject_id = $1 ORDER BY g.created_at`,
      [s["id"]],
    );
    const { id: _id, ...rest } = s;
    return { ...rest, grants: grants.rows } as SubjectDetail;
  }

  async events(opts: { limit?: number; subject?: string; denied?: boolean } = {}) {
    const org = await this.org();
    const { rows } = await this.db.query(
      `SELECT e.created_at, e.event_type, e.subject_external_id AS subject, e.permission_slug AS action,
         sp.slug AS space, e.allowed, e.matched_role_slugs AS via, e.context
       FROM keyring.check_events e LEFT JOIN keyring.spaces sp ON sp.id = e.space_id
       WHERE e.organization_id = $1 AND ($2::text IS NULL OR e.subject_external_id = $2) AND ($3::boolean IS NULL OR e.allowed = NOT $3)
       ORDER BY e.created_at DESC LIMIT $4`,
      [org.id, opts.subject ?? null, opts.denied ? true : null, Math.min(opts.limit ?? 50, 1000)],
    );
    return rows;
  }

  /** Raw decisions over a window for Studio's telemetry charts (bucketed client-side, in local time). */
  async telemetry(opts: { days?: number; action?: string | null; result?: "all" | "allowed" | "denied"; space?: string | null } = {}) {
    const org = await this.org();
    const days = Math.min(Math.max(Math.floor(opts.days ?? 30), 1), 90);
    const sid = await this.spaceId(opts.space);
    const allowed = opts.result === "allowed" ? true : opts.result === "denied" ? false : null;
    const { rows } = await this.db.query(
      `SELECT e.created_at, e.allowed, e.permission_slug AS action, e.subject_external_id AS subject, e.matched_role_slugs AS via
       FROM keyring.check_events e
       WHERE e.organization_id = $1 AND e.created_at > now() - make_interval(days => $2::int)
         AND ($3::text IS NULL OR e.permission_slug = $3) AND ($4::boolean IS NULL OR e.allowed = $4)
         AND e.space_id IS NOT DISTINCT FROM $5::uuid
       ORDER BY e.created_at LIMIT 20000`,
      [org.id, days, opts.action || null, allowed, sid],
    );
    return rows;
  }

  async listKeys() {
    const org = await this.org();
    const { rows } = await this.db.query(
      `SELECT id, name, prefix, key_type, scopes, created_at, last_used_at, expires_at, revoked_at
       FROM keyring.api_keys WHERE organization_id = $1 ORDER BY created_at`,
      [org.id],
    );
    return rows;
  }

  async issueKey(input: { name: string; scopes?: string[]; publishable?: boolean }) {
    const org = await this.org();
    const type = input.publishable ? "publishable" : "secret";
    const scopes = input.scopes?.length ? input.scopes : type === "publishable" ? ["check"] : [...ALL_SCOPES];
    const bad = scopes.filter((s) => !(ALL_SCOPES as readonly string[]).includes(s));
    if (bad.length) throw new CliError(`Unknown scope(s): ${bad.join(", ")}`, "invalid_scope", `Valid scopes: ${ALL_SCOPES.join(", ")}`);
    const { key, hash, prefix } = generateApiKey(type);
    const { rows } = await this.db.query("SELECT keyring.keyring_issue_key($1, $2, $3, $4, $5, $6) AS id", [
      org.slug,
      input.name,
      hash,
      prefix,
      scopes,
      type,
    ]);
    return { id: rows[0]?.["id"] as string, name: input.name, key, key_type: type, scopes };
  }

  async revokeKey(idOrPrefix: string) {
    const org = await this.org();
    const { rows } = await this.db.query(
      `UPDATE keyring.api_keys SET revoked_at = now()
       WHERE organization_id = $1 AND revoked_at IS NULL AND (id::text = $2 OR prefix = $2 OR name = $2)
       RETURNING id, name, prefix`,
      [org.id, idOrPrefix],
    );
    if (rows.length === 0) throw new CliError(`No active key matches ${idOrPrefix}`, "unknown_key", "List keys with `keyring keys`.");
    return rows;
  }

  async setDefaultRole(role: string | null, space?: string | null) {
    const org = await this.org();
    if (role == null) {
      const sid = await this.spaceId(space);
      if (sid) await this.db.query("UPDATE keyring.spaces SET default_role_id = NULL WHERE id = $1", [sid]);
      else await this.db.query("UPDATE keyring.organizations SET default_role_id = NULL WHERE id = $1", [org.id]);
      return;
    }
    await this.db.query("SELECT keyring.keyring_set_default_role($1, $2, $3)", [org.slug, role, space ?? null]);
  }

  async deleteRole(slug: string, space?: string | null) {
    const org = await this.org();
    const sid = await this.spaceId(space);
    await this.db.query(
      "DELETE FROM keyring.roles WHERE organization_id = $1 AND scope = 'customer' AND slug = $2 AND space_id IS NOT DISTINCT FROM $3::uuid",
      [org.id, slug, sid],
    );
  }

  async deleteAction(slug: string, space?: string | null) {
    const org = await this.org();
    const sid = await this.spaceId(space);
    await this.db.query(
      "DELETE FROM keyring.permissions WHERE organization_id = $1 AND scope = 'customer' AND slug = $2 AND space_id IS NOT DISTINCT FROM $3::uuid",
      [org.id, slug, sid],
    );
  }

  async unlinkAction(role: string, action: string, space?: string | null) {
    const org = await this.org();
    const sid = await this.spaceId(space);
    await this.db.query(
      `DELETE FROM keyring.role_permissions rp USING keyring.roles r, keyring.permissions p
       WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.organization_id = $1
         AND r.slug = $2 AND p.slug = $3 AND r.space_id IS NOT DISTINCT FROM $4::uuid`,
      [org.id, role, action, sid],
    );
  }
}
