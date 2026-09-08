/*
 * Isomorphic API-key helpers (no node: imports — safe in client bundles,
 * server routes, and the edge runtime). Raw keys only ever exist in memory
 * at creation time; only the SHA-256 hex is stored.
 */

export function newApiKey(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  const b64url = btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `kr_live_${b64url}`;
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
