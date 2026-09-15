/**
 * Built-in Management API scopes for issued API keys.
 * These are Keyring's own API capabilities — not the customer's action slugs.
 *
 * Dot notation groups in the Polar-style TreeMultiSelect (separator ".").
 */

export const API_KEY_SCOPES = [
  "check",
  "grants.write",
  "roles.read",
  "actions.read",
  "subject_tokens.write",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const PUBLISHABLE_SCOPES: readonly ApiKeyScope[] = ["check"];

export const SECRET_DEFAULT_SCOPES: readonly ApiKeyScope[] = [...API_KEY_SCOPES];

const SCOPE_SET = new Set<string>(API_KEY_SCOPES);

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return SCOPE_SET.has(value);
}

export function normalizeScopes(raw: unknown): ApiKeyScope[] {
  if (!Array.isArray(raw)) return [];
  const out: ApiKeyScope[] = [];
  for (const item of raw) {
    if (typeof item === "string" && isApiKeyScope(item) && !out.includes(item)) {
      out.push(item);
    }
  }
  return out;
}

/** Publishable keys may only hold the safe subset. */
export function scopesAllowedForKind(
  kind: "secret" | "publishable",
  scopes: readonly string[],
): ApiKeyScope[] {
  const normalized = normalizeScopes(scopes);
  if (kind === "publishable") {
    return normalized.filter((s) =>
      (PUBLISHABLE_SCOPES as readonly string[]).includes(s),
    );
  }
  return normalized;
}

export function hasScope(
  scopes: readonly string[] | null | undefined,
  scope: ApiKeyScope,
): boolean {
  return (scopes ?? []).includes(scope);
}
