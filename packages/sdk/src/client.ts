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
  CreateSpaceInput,
  CreateSubjectTokenInput,
  CreateWebhookInput,
  CreateWebhookResult,
  GrantInput,
  GrantResult,
  KeyringOptions,
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
  SubjectTokenSource,
  TrackOptions,
  TrackResult,
  WebhookEndpoint,
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
   * `check(subject, permission, { context, space })` for ABAC / spaces.
   * Browser (publishable key): `check(permission)` or
   * `check(permission, { subjectToken, context, space })`
   * Space is optional: omitted = platform scope, a slug = that space only.
   */
  check(subject: string, permission: string, opts?: { context?: Record<string, unknown>; space?: string }): Promise<CheckResult>;
  check(permission: string, opts?: CheckOptions): Promise<CheckResult>;
  async check(
    subjectOrPermission: string,
    permissionOrOpts?: string | CheckOptions,
    secretOpts?: { context?: Record<string, unknown>; space?: string },
  ): Promise<CheckResult> {
    if (typeof permissionOrOpts === "string") {
      requireSecretKey(this.apiKey, "pass a raw subject to check()");
      return this.requestCheck({
        subject: subjectOrPermission,
        permission: permissionOrOpts,
        context: secretOpts?.context,
        space: secretOpts?.space,
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
      space: permissionOrOpts?.space,
    });
  }

  assert(subject: string, permission: string, opts?: { space?: string }): Promise<CheckResult>;
  assert(permission: string, opts?: CheckOptions): Promise<CheckResult>;
  async assert(
    subjectOrPermission: string,
    permissionOrOpts?: string | CheckOptions,
    secretOpts?: { space?: string },
  ): Promise<CheckResult> {
    const result =
      typeof permissionOrOpts === "string"
        ? await this.check(subjectOrPermission, permissionOrOpts, secretOpts)
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
        space: input.space,
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

  /** Provision a subject into the DEFAULT role of one scope (space slug or
   *  omitted for the platform scope). No role slug — the server resolves it.
   *  Idempotent (`granted: false` when already held). */
  async provisionSubject(input: ProvisionSubjectInput): Promise<ProvisionSubjectResult> {
    requireSecretKey(this.apiKey, "provision subjects");
    return apiRequest<ProvisionSubjectResult>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/subjects/provision",
      method: "POST",
      body: {
        subject: input.subject,
        display_name: input.displayName,
        space: input.space,
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
        space: input.space,
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  /** Grant `to`, then revoke `from` (same scope). If revoke fails after grant, the subject may briefly hold both. */
  async replaceRole(input: ReplaceRoleInput): Promise<void> {
    await this.grantRole({
      role: input.to,
      subject: input.subject,
      displayName: input.displayName,
      space: input.space,
      ...(input.expiresAt != null ? { expiresAt: input.expiresAt } : {}),
      ...(input.ttlSeconds != null ? { ttlSeconds: input.ttlSeconds } : {}),
      ...(input.condition != null ? { condition: input.condition } : {}),
    });
    await this.revokeRole({
      role: input.from,
      subject: input.subject,
      space: input.space,
    });
  }

  /**
   * Create (or update) a role in the key's workspace + scope. Idempotent —
   * re-creating the same slug updates name/description and adds permission
   * links. Secret key with `roles.write` scope only.
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
        space: input.space,
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  /**
   * Create (or update) an action in the key's workspace + scope. Idempotent.
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
        space: input.space,
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  /** Alias for createPermission() — matches product “actions” language. */
  createAction(input: CreatePermissionInput): Promise<CreatePermissionResult> {
    return this.createPermission(input);
  }

  async listRoles(space?: string): Promise<Role[]> {
    requireSecretKey(this.apiKey, "list roles");
    const data = await apiRequest<{ roles: Role[] }>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/roles",
      query: space ? { space } : undefined,
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
    return data.roles ?? [];
  }

  async listPermissions(space?: string): Promise<Permission[]> {
    requireSecretKey(this.apiKey, "list permissions");
    const data = await apiRequest<{ permissions: Permission[] }>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/permissions",
      query: space ? { space } : undefined,
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
        space: opts?.space,
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  /**
   * Full access snapshot for one subject in one scope — backfill + nightly
   * reconcile for customer mirrors (keyring.access). Secret key with
   * `check` scope. Unknown subject → empty roles/permissions (not 404).
   */
  async getSubjectAccess(subject: string, space?: string): Promise<SubjectAccess> {
    requireSecretKey(this.apiKey, "read subject access snapshots");
    return apiRequest<SubjectAccess>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/subjects/access",
      query: space ? { subject, space } : { subject },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  /** List spaces. Secret key with `spaces.read`. */
  async listSpaces(): Promise<Space[]> {
    requireSecretKey(this.apiKey, "list spaces");
    const data = await apiRequest<{ spaces: Space[] }>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/spaces",
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
    return data.spaces ?? [];
  }

  /** Create (or update) a space. Secret key with `spaces.write`. */
  async createSpace(input: CreateSpaceInput): Promise<Space> {
    requireSecretKey(this.apiKey, "create spaces");
    return apiRequest<Space>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/spaces",
      method: "POST",
      body: {
        slug: input.slug,
        name: input.name,
        description: input.description,
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  /** Delete a space (cascades to its roles, actions and grants).
   *  Secret key with `spaces.write`. */
  async deleteSpace(space: string): Promise<void> {
    requireSecretKey(this.apiKey, "delete spaces");
    await apiRequest<{ ok: true }>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/spaces",
      method: "DELETE",
      body: { space },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  /** List outbound webhook endpoints. Secret key with `webhooks.read`. */
  async listWebhooks(): Promise<WebhookEndpoint[]> {
    requireSecretKey(this.apiKey, "list webhooks");
    const data = await apiRequest<{ endpoints: WebhookEndpoint[] }>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/webhooks",
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
    return data.endpoints ?? [];
  }

  /** Create an outbound webhook endpoint. Secret key with `webhooks.write`.
   * Omit secret to have the server mint one — returned once in `.secret`. */
  async createWebhook(input: CreateWebhookInput): Promise<CreateWebhookResult> {
    requireSecretKey(this.apiKey, "create webhooks");
    return apiRequest<CreateWebhookResult>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/webhooks",
      method: "POST",
      body: {
        name: input.name,
        url: input.url,
        secret: input.secret,
        events: input.events,
      },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  /** Delete an outbound webhook endpoint. Secret key with `webhooks.write`. */
  async deleteWebhook(id: string): Promise<void> {
    requireSecretKey(this.apiKey, "delete webhooks");
    await apiRequest<{ ok: true }>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/webhooks",
      method: "DELETE",
      body: { id },
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }

  private requestCheck(input: {
    permission: string;
    subject?: string;
    subjectToken?: string;
    context?: Record<string, unknown>;
    space?: string;
  }): Promise<CheckResult> {
    // Secret-key path can also pass an explicit subject + context.
    // Browser path resolves subject from the JWT; context rides along.
    const query: Record<string, string | undefined> = {
      permission: input.permission,
      subject: input.subject,
      space: input.space,
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
