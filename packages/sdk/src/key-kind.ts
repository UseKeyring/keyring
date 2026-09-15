import type { KeyKind } from "./types.js";

export function detectKeyKind(apiKey: string): KeyKind {
  if (apiKey.startsWith("kr_pk_")) return "publishable";
  return "secret";
}

export function requireSecretKey(apiKey: string, action: string): void {
  if (detectKeyKind(apiKey) === "publishable") {
    throw new Error(
      `Publishable keys cannot ${action}. Use a secret key (kr_sk_…) on the server.`,
    );
  }
}
