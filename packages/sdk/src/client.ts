import { ForbiddenError } from "./errors.js";
import { apiRequest } from "./http.js";
import { detectKeyKind, requireSecretKey } from "./key-kind.js";
import type {
  CheckOptions,
  CheckResult,
  CreatePermissionInput,
  CreatePermissionResult,
  CreateRoleInput,
  CreateRoleResult,
  CreateSubjectTokenInput,
  GrantInput,
  GrantResult,
  KeyringOptions,
  Permission,
  ReplaceRoleInput,
  RevokeInput,
  RevokeResult,
  Role,
  SetSubjectAttrsInput,
  SetSubjectAttrsResult,
  SubjectTokenResult,
  SubjectTokenSource,
  TrackOptions,
  TrackResult,
} from "./types.js";

async function resolveSubjectToken(
  source: SubjectTokenSource | undefined,
  override?: string,
): Promise<string | undefined> {
  if (override) return override;
  if (source == null) return undefined;
  if (typeof source === "string") return source;
  const value = await source();
  return value ?? undefined;
}

export class Keyring {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly keyKind: ReturnType<typeof detectKeyKind>;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders?: Record<string, string>;
  private readonly subjectTokenSource?: SubjectTokenSource;

  constructor(options: KeyringOptions) {
    if (!options.apiKey?.trim()) throw new Error("apiKey is required");
    if (!options.baseUrl?.trim()) throw new Error("baseUrl is required");
    this.apiKey = options.apiKey.trim();
    this.baseUrl = options.baseUrl.trim();
    this.keyKind = detectKeyKind(this.apiKey);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.extraHeaders = options.headers;
    this.subjectTokenSource = options.subjectToken;
  }

  /**
   * Server (secret key): `check(subject, permission)` or
   * `check(subject, permission, { context })` for ABAC.
   * Browser (publishable key): `check(permission)` or
   * `check(permission, { subjectToken, context })`
   */
  check(subject: string, permission: string, opts?: { context?: Record<string, unknown> }): Promise<CheckResult>;
  check(permission: string, opts?: CheckOptions): Promise<CheckResult>;
  async check(
    subjectOrPermission: string,
    permissionOrOpts?: string | CheckOptions,
    secretOpts?: { context?: Record<string, unknown> },
  ): Promise<CheckResult> {
    if (typeof permissionOrOpts === "string") {
      requireSecretKey(this.apiKey, "pass a raw subject to check()");
      return this.requestCheck({
        subject: subjectOrPermission,
        permission: permissionOrOpts,
        context: secretOpts?.context,
      });
    }

    if (this.keyKind === "secret") {
      throw new Error(
        'Secret-key check() requires check(subject, permission). For publishable keys use check(permission).',
      );
    }

    const subjectToken = await resolveSubjectToken(
      this.subjectTokenSource,
      permissionOrOpts?.subjectToken,
    );
    if (!subjectToken) {
      throw new Error(
        "Publishable-key check() requires a subject token (constructor subjectToken or opts.subjectToken).",
      );
    }

    return this.requestCheck({
      permission: subjectOrPermission,
      subjectToken,
      context: permissionOrOpts?.context,
    });
  }

  assert(subject: string, permission: string): Promise<CheckResult>;
  assert(permission: string, opts?: CheckOptions): Promise<CheckResult>;
  async assert(
    subjectOrPermission: string,
    permissionOrOpts?: string | CheckOptions,
  ): Promise<CheckResult> {
    const result =
      typeof permissionOrOpts === "string"
        ? await this.check(subjectOrPermission, permissionOrOpts)
        : await this.check(subjectOrPermission, permissionOrOpts);
    if (!result.allowed) {
      throw new ForbiddenError(
        `Permission denied: ${result.permission} for subject ${result.subject}`,
      );
    }
    return result;
  }

  async createSubjectToken(input: CreateSubjectTokenInput): Promise<SubjectTokenResult> {
    requireSecretKey(this.apiKey, "mint subject tokens");
    const data = await apiRequest<{
      token: string;
      subject: string;
      expires_at: string;
    }>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/subject-tokens",
      method: "POST",
      body: {
        subject: input.subject,
        ttl_seconds: input.ttlSeconds,
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
    return {
      token: data.token,
      subject: data.subject,
      expiresAt: new Date(data.expires_at),
    };
  }

  async grantRole(input: GrantInput): Promise<GrantResult> {
    requireSecretKey(this.apiKey, "grant roles");
    return apiRequest<GrantResult>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/grants",
      method: "POST",
      body: {
        role: input.role,
        subject: input.subject,
        display_name: input.displayName,
        expires_at:
          input.expiresAt instanceof Date
            ? input.expiresAt.toISOString()
            : (input.expiresAt ?? undefined),
        ttl_seconds: input.ttlSeconds,
        condition: input.condition,
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  /** Upsert subject attributes (merged) — feeds ABAC grant conditions. */
  async setSubjectAttrs(input: SetSubjectAttrsInput): Promise<SetSubjectAttrsResult> {
    requireSecretKey(this.apiKey, "set subject attributes");
    return apiRequest<SetSubjectAttrsResult>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/subjects",
      method: "POST",
      body: {
        subject: input.subject,
        attrs: input.attrs,
        display_name: input.displayName,
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  async revokeRole(input: RevokeInput): Promise<RevokeResult> {
    requireSecretKey(this.apiKey, "revoke roles");
    return apiRequest<RevokeResult>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/grants",
      method: "DELETE",
      body: {
        role: input.role,
        subject: input.subject,
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  /** Grant `to`, then revoke `from`. If revoke fails after grant, the subject may briefly hold both. */
  async replaceRole(input: ReplaceRoleInput): Promise<void> {
    await this.grantRole({
      role: input.to,
      subject: input.subject,
      displayName: input.displayName,
      ...(input.expiresAt != null ? { expiresAt: input.expiresAt } : {}),
      ...(input.ttlSeconds != null ? { ttlSeconds: input.ttlSeconds } : {}),
      ...(input.condition != null ? { condition: input.condition } : {}),
    });
    await this.revokeRole({
      role: input.from,
      subject: input.subject,
    });
  }

  /**
   * Create (or update) a role in the key's workspace. Idempotent — re-creating
   * the same slug updates name/description and adds permission links.
   * Secret key with `roles.write` scope only.
   */
  async createRole(input: CreateRoleInput): Promise<CreateRoleResult> {
    requireSecretKey(this.apiKey, "create roles");
    return apiRequest<CreateRoleResult>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/roles",
      method: "POST",
      body: {
        slug: input.slug,
        name: input.name,
        description: input.description,
        permissions: input.permissions,
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  /**
   * Create (or update) an action in the key's workspace. Idempotent.
   * Secret key with `actions.write` scope only.
   */
  async createPermission(input: CreatePermissionInput): Promise<CreatePermissionResult> {
    requireSecretKey(this.apiKey, "create actions");
    return apiRequest<CreatePermissionResult>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/permissions",
      method: "POST",
      body: {
        slug: input.slug,
        name: input.name,
        category: input.category,
        description: input.description,
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  /** Alias for createPermission() — matches product “actions” language. */
  createAction(input: CreatePermissionInput): Promise<CreatePermissionResult> {
    return this.createPermission(input);
  }

  async listRoles(): Promise<Role[]> {
    requireSecretKey(this.apiKey, "list roles");
    const data = await apiRequest<{ roles: Role[] }>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/roles",
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
    return data.roles ?? [];
  }

  async listPermissions(): Promise<Permission[]> {
    requireSecretKey(this.apiKey, "list permissions");
    const data = await apiRequest<{ permissions: Permission[] }>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/permissions",
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
    return data.permissions ?? [];
  }

  /** Alias for listPermissions() — matches product “actions” language. */
  listActions(): Promise<Permission[]> {
    return this.listPermissions();
  }

  /**
   * Manual telemetry event, paired with auto-logged check() rows.
   * Secret key with `telemetry.write` scope only. When `allowed` is omitted
   * the server resolves it against the RBAC graph at track time.
   */
  async track(
    subject: string,
    permission: string,
    opts?: TrackOptions,
  ): Promise<TrackResult> {
    requireSecretKey(this.apiKey, "track custom events");
    return apiRequest<TrackResult>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/events",
      method: "POST",
      body: {
        subject,
        permission,
        allowed: opts?.allowed,
        context: opts?.context ?? {},
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  private requestCheck(input: {
    permission: string;
    subject?: string;
    subjectToken?: string;
    context?: Record<string, unknown>;
  }): Promise<CheckResult> {
    // Secret-key path can also pass an explicit subject + context.
    // Browser path resolves subject from the JWT; context rides along.
    const query: Record<string, string | undefined> = {
      permission: input.permission,
      subject: input.subject,
    };
    if (input.context && Object.keys(input.context).length > 0) {
      query["context"] = JSON.stringify(input.context);
    }
    return apiRequest<CheckResult>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/check",
      query,
      subjectToken: input.subjectToken,
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }
}
