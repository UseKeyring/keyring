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

export type CheckResult = {
  subject: string;
  permission: string;
  allowed: boolean;
};

export type GrantResult = {
  ok: true;
  role: string;
  subject: string;
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
};

export type CreateSubjectTokenInput = {
  subject: string;
  ttlSeconds?: number;
};

export type CheckOptions = {
  subjectToken?: string;
};
