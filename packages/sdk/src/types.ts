export type KeyKind = "secret" | "publishable";

export type SubjectTokenSource = string | (() => string | null | undefined | Promise<string | null | undefined>);

export type KeyringOptions = {
  /** Secret (`kr_sk_…` / legacy `kr_live_…`) or publishable (`kr_pk_…`) API key. */
  apiKey: string;
  /** Keyring app origin, e.g. https://app.example.com */
  baseUrl: string;
  /** Browser: subject token string or lazy getter (cookie / memory). */
  subjectToken?: SubjectTokenSource;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
};

export type AbacCondition = Record<string, unknown>;

export type CheckResult = {
  subject: string;
  permission: string;
  allowed: boolean;
};

export type GrantResult = {
  ok: true;
  role: string;
  subject: string;
  expires_at?: string | null;
  ttl_seconds?: number | null;
  condition?: AbacCondition | null;
};

export type SetSubjectAttrsResult = {
  ok: true;
  subject: string;
  attrs: Record<string, unknown>;
};

export type RevokeResult = {
  ok: true;
  revoked: true;
};

export type SubjectTokenResult = {
  token: string;
  subject: string;
  expiresAt: Date;
};

export type Role = {
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
};

export type Permission = {
  slug: string;
  name: string;
  description: string | null;
  category: string;
  created_at: string;
};

export type GrantInput = {
  role: string;
  subject: string;
  displayName?: string;
  /**
   * Temporary access: absolute expiry (Date or ISO string) or TTL in seconds
   * (e.g. `ttlSeconds: 300` = access for the next 5 minutes).
   * `ttlSeconds` wins when both are given. Omitted = permanent grant.
   */
  expiresAt?: Date | string;
  ttlSeconds?: number;
  /**
   * ABAC gate on the grant, e.g. `{ attr: "plan", in: ["pro","enterprise"] }`.
   * `{ all: [...] }`, `{ any: [...] }`, `{ not: {...} }` compose.
   * Omitted = unconditional.
   */
  condition?: AbacCondition;
};

export type SetSubjectAttrsInput = {
  subject: string;
  attrs: Record<string, unknown>;
  displayName?: string;
};

export type RevokeInput = {
  role: string;
  subject: string;
};

export type ReplaceRoleInput = {
  subject: string;
  from: string;
  to: string;
  displayName?: string;
  expiresAt?: Date | string;
  ttlSeconds?: number;
  condition?: AbacCondition;
};

export type CreateSubjectTokenInput = {
  subject: string;
  ttlSeconds?: number;
};

export type CheckOptions = {
  subjectToken?: string;
  /** ABAC request context, e.g. `{ plan: "pro" }` — context wins over stored attrs. */
  context?: Record<string, unknown>;
};

export type CheckWithContextInput = {
  permission: string;
  context?: Record<string, unknown>;
};

export type TrackOptions = {
  allowed?: boolean;
  context?: Record<string, unknown>;
};

export type TrackResult = {
  ok: true;
  id: string;
};
