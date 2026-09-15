import { ForbiddenError } from "./errors.js";
import { apiRequest } from "./http.js";
import { detectKeyKind, requireSecretKey } from "./key-kind.js";
import type {
  CheckOptions,
  CheckResult,
  CreateSubjectTokenInput,
  GrantInput,
  GrantResult,
  KeyringOptions,
  Permission,
  ReplaceRoleInput,
  RevokeInput,
  RevokeResult,
  Role,
  SubjectTokenResult,
  SubjectTokenSource,
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
   * Server (secret key): `check(subject, permission)`
   * Browser (publishable key): `check(permission)` or `check(permission, { subjectToken })`
   */
  check(subject: string, permission: string): Promise<CheckResult>;
  check(permission: string, opts?: CheckOptions): Promise<CheckResult>;
  async check(
    subjectOrPermission: string,
    permissionOrOpts?: string | CheckOptions,
  ): Promise<CheckResult> {
    if (typeof permissionOrOpts === "string") {
      requireSecretKey(this.apiKey, "pass a raw subject to check()");
      return this.requestCheck({
        subject: subjectOrPermission,
        permission: permissionOrOpts,
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
    });
    await this.revokeRole({
      role: input.from,
      subject: input.subject,
    });
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

  private requestCheck(input: {
    permission: string;
    subject?: string;
    subjectToken?: string;
  }): Promise<CheckResult> {
    return apiRequest<CheckResult>({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      path: "/api/v1/check",
      query: {
        permission: input.permission,
        subject: input.subject,
      },
      subjectToken: input.subjectToken,
      fetchImpl: this.fetchImpl,
      headers: this.extraHeaders,
    });
  }
}
