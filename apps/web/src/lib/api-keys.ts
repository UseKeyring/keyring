/*
 * Isomorphic API-key helpers (no node: imports — safe in client bundles,
 * server routes, and the edge runtime). Raw keys only ever exist in memory
 * at creation time; only the SHA-256 hex is stored.
 *
 * secret:       kr_sk_live_…  (server-only; grant/revoke/list/check/mint)
 * publishable:  kr_pk_live_…  (browser-safe; check + subject token only)
 * legacy:       kr_live_…     (treated as secret)
 */

export type ApiKeyKind = "secret" | "publishable";

function randomKeyBody(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function newApiKey(kind: ApiKeyKind = "secret"): string {
  const prefix = kind === "publishable" ? "kr_pk_live_" : "kr_sk_live_";
  return `${prefix}${randomKeyBody()}`;
}

/** @deprecated Prefer newApiKey("secret") — kept for call sites that expect the old name. */
export function newSecretApiKey(): string {
  return newApiKey("secret");
}

export function newPublishableApiKey(): string {
  return newApiKey("publishable");
}

export function detectApiKeyKind(raw: string): ApiKeyKind {
  if (raw.startsWith("kr_pk_")) return "publishable";
  return "secret";
}

export async function hashApiKey(raw: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
