/**
 * Embedded mode — Keyring inside YOUR Postgres, no hosted API in the path.
 *
 *   import { Pool } from "pg";
 *   import { createKeyring } from "@usekeyring/sdk/postgres";
 *
 *   export const keyring = createKeyring({
 *     database: new Pool({ connectionString: process.env.DATABASE_URL }),
 *     apiKey: process.env.KEYRING_SECRET_KEY!,
 *   });
 *   await keyring.check("user_123", "invoices.refund");
 *
 * Same method names and result shapes as the HTTP `Keyring` client, so code
 * moves between hosted and self-hosted by swapping the constructor. Every call
 * is one `SELECT keyring.api_*(...)` against the schema `keyring migrate`
 * installs (drizzle/native.sql) — key-hash authed, org-scoped, scope-checked
 * inside Postgres. Any driver with `query(text, values) → { rows }` works:
 * `pg` Pool/Client, `@neondatabase/serverless` Pool, PGlite.
 */
import {
  BadRequestError,
  ForbiddenError,
  KeyringError,
  NotFoundError,
  UnauthorizedError,
} from "./errors.js";
import type {
  CheckResult,
  CreatePermissionInput,
  CreatePermissionResult,
  CreateRoleInput,
  CreateRoleResult,
  CreateSpaceInput,
  CreateSubjectTokenInput,
  GrantInput,
  GrantResult,
  Permission,
  ProvisionSubjectInput,
  ProvisionSubjectResult,
  ReplaceRoleInput,
  RevokeInput,
  RevokeResult,
  Role,
  SetSubjectAttrsInput,
  SetSubjectAttrsResult,
  Space,
  SubjectAccess,
  SubjectTokenResult,
  TrackOptions,
  TrackResult,
} from "./types.js";

/** Minimal driver contract — `pg`, Neon serverless and PGlite all satisfy it. */
export type SqlExecutor = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

export type PostgresKeyringOptions = {
  database: SqlExecutor;
  /** Secret key (`kr_sk_live_…`). Only its SHA-256 ever reaches the database. */
  apiKey: string;
};

export type WhoAmI = {
  name: string;
  organization_id: string;
  key_type: "secret" | "publishable";
  scopes: string[];
  expires_at: string | null;
};

export async function hashApiKey(apiKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(apiKey.trim());
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Turn `RAISE EXCEPTION 'unknown_role:viewer'` into a typed SDK error. */
export function errorFromPostgres(err: unknown): KeyringError {
  if (err instanceof KeyringError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  if (code !== "P0001") {
    return new KeyringError(message, 500, { error: message, code: code ?? "database_error" });
  }
  const [reason = "error", ...rest] = message.split(":");
  const detail = rest.join(":").trim();
  // unknown_role:viewer → "Unknown role: viewer" (code stays machine-readable)
  const words = reason.replace(/_/g, " ");
  const human = `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}${detail ? `: ${detail}` : ""}`;
  const body = { error: human, code: reason };
  if (reason.startsWith("unknown_")) return new NotFoundError(human, body);
  if (reason.endsWith("_forbidden")) return new ForbiddenError(human, body);
  return new BadRequestError(human, body);
}

export class PostgresKeyring {
  readonly keyKind = "secret" as const;
  private readonly db: SqlExecutor;
  private readonly apiKey: string;
  private hash?: Promise<string>;

  constructor(options: PostgresKeyringOptions) {
    if (!options.database) throw new Error("database is required");
    if (!options.apiKey?.trim()) throw new Error("apiKey is required");
    if (options.apiKey.startsWith("kr_pk_")) {
      throw new Error("Embedded mode runs server-side: use a secret key (kr_sk_…).");
    }
    this.db = options.database;
    this.apiKey = options.apiKey.trim();
  }

  /** Call `keyring.<fn>(hash, ...args)`; NULL means bad key or missing scope. */
  private async rpc<T>(fn: string, scope: string, args: unknown[]): Promise<T> {
    this.hash ??= hashApiKey(this.apiKey);
    const hash = await this.hash;
    const placeholders = args.map((_, i) => `$${i + 2}`).join(", ");
    const sql = `SELECT keyring.${fn}($1${placeholders ? `, ${placeholders}` : ""}) AS r`;
    let rows: Record<string, unknown>[];
    try {
      ({ rows } = await this.db.query(sql, [hash, ...args]));
    } catch (err) {
      throw errorFromPostgres(err);
    }
    const value = rows[0]?.["r"];
    if (value === null || value === undefined) {
      throw new UnauthorizedError(
        `Invalid, revoked or expired key — or it lacks the \`${scope}\` scope.`,
        { error: "unauthorized", code: "unauthorized" },
      );
    }
    return value as T;
  }

  whoami(): Promise<WhoAmI> {
    return this.rpc<WhoAmI>("api_whoami", "any", []);
  }

  async check(
    subject: string,
    permission: string,
    opts?: { context?: Record<string, unknown>; space?: string },
  ): Promise<CheckResult> {
    const allowed = await this.rpc<boolean>("api_check", "check", [
      subject,
      permission,
      JSON.stringify(opts?.context ?? {}),
      opts?.space ?? null,
    ]);
    return { subject, permission, space: opts?.space ?? null, allowed };
  }

  async assert(subject: string, permission: string, opts?: { space?: string }): Promise<CheckResult> {
    const result = await this.check(subject, permission, opts);
    if (!result.allowed) {
      throw new ForbiddenError(`Permission denied: ${permission} for subject ${subject}`);
    }
    return result;
  }

  async grantRole(input: GrantInput): Promise<GrantResult> {
    const expiresAt =
      input.expiresAt instanceof Date ? input.expiresAt.toISOString() : (input.expiresAt ?? null);
    await this.rpc<boolean>("api_grant_role", "grants.write", [
      input.role,
      input.subject,
      input.displayName ?? null,
      input.ttlSeconds != null ? null : expiresAt,
      input.ttlSeconds ?? null,
      input.condition ? JSON.stringify(input.condition) : null,
      input.space ?? null,
    ]);
    return {
      ok: true,
      role: input.role,
      subject: input.subject,
      space: input.space ?? null,
      expires_at:
        input.ttlSeconds != null
          ? new Date(Date.now() + input.ttlSeconds * 1000).toISOString()
          : expiresAt,
      ttl_seconds: input.ttlSeconds ?? null,
      condition: input.condition ?? null,
    };
  }

  async revokeRole(input: RevokeInput): Promise<RevokeResult> {
    await this.rpc<boolean>("api_revoke_grant", "grants.write", [
      input.role,
      input.subject,
      input.space ?? null,
    ]);
    return { ok: true, revoked: true };
  }

  async replaceRole(input: ReplaceRoleInput): Promise<void> {
    await this.grantRole({
      role: input.to,
      subject: input.subject,
      displayName: input.displayName,
      space: input.space,
      expiresAt: input.expiresAt,
      ttlSeconds: input.ttlSeconds,
      condition: input.condition,
    });
    await this.revokeRole({ role: input.from, subject: input.subject, space: input.space });
  }

  provisionSubject(input: ProvisionSubjectInput): Promise<ProvisionSubjectResult> {
    return this.rpc<ProvisionSubjectResult>("api_provision_subject", "grants.write", [
      input.subject,
      input.displayName ?? null,
      input.space ?? null,
    ]);
  }

  async setSubjectAttrs(input: SetSubjectAttrsInput): Promise<SetSubjectAttrsResult> {
    await this.rpc<boolean>("api_set_subject_attrs", "grants.write", [
      input.subject,
      JSON.stringify(input.attrs),
      input.displayName ?? null,
    ]);
    return { ok: true, subject: input.subject, attrs: input.attrs };
  }

  createRole(input: CreateRoleInput): Promise<CreateRoleResult> {
    return this.rpc<CreateRoleResult>("api_create_role", "roles.write", [
      input.slug,
      input.name,
      input.description ?? null,
      input.permissions ?? null,
      input.space ?? null,
    ]);
  }

  createPermission(input: CreatePermissionInput): Promise<CreatePermissionResult> {
    return this.rpc<CreatePermissionResult>("api_create_permission", "actions.write", [
      input.slug,
      input.name,
      input.category ?? null,
      input.description ?? null,
      input.space ?? null,
    ]);
  }

  createAction(input: CreatePermissionInput): Promise<CreatePermissionResult> {
    return this.createPermission(input);
  }

  listRoles(space?: string): Promise<Role[]> {
    return this.rpc<Role[]>("api_list_roles", "roles.read", [space ?? null]);
  }

  listPermissions(space?: string): Promise<Permission[]> {
    return this.rpc<Permission[]>("api_list_permissions", "actions.read", [space ?? null]);
  }

  listActions(space?: string): Promise<Permission[]> {
    return this.listPermissions(space);
  }

  async track(subject: string, permission: string, opts?: TrackOptions): Promise<TrackResult> {
    const id = await this.rpc<string>("api_track_event", "telemetry.write", [
      subject,
      permission,
      opts?.allowed ?? null,
      JSON.stringify(opts?.context ?? {}),
      opts?.space ?? null,
    ]);
    return { ok: true, id };
  }

  getSubjectAccess(subject: string, space?: string): Promise<SubjectAccess> {
    return this.rpc<SubjectAccess>("api_get_subject_access", "check", [subject, space ?? null]);
  }

  listSpaces(): Promise<Space[]> {
    return this.rpc<Space[]>("api_list_spaces", "spaces.read", []);
  }

  createSpace(input: CreateSpaceInput): Promise<Space> {
    return this.rpc<Space>("api_create_space", "spaces.write", [
      input.slug,
      input.name,
      input.description ?? null,
    ]);
  }

  async deleteSpace(space: string): Promise<void> {
    await this.rpc<boolean>("api_delete_space", "spaces.write", [space]);
  }

  async createSubjectToken(_input?: CreateSubjectTokenInput): Promise<SubjectTokenResult> {
    throw new BadRequestError(
      "Subject tokens are signed by the hosted API (SUBJECT_TOKEN_SECRET). In embedded mode, check server-side instead.",
      { error: "unsupported_in_embedded_mode", code: "unsupported_in_embedded_mode" },
    );
  }
}

export function createKeyring(options: PostgresKeyringOptions): PostgresKeyring {
  return new PostgresKeyring(options);
}
