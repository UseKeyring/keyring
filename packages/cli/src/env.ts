import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

/** Load .env files Next/Vite-style (later files never override earlier or real env). */
export function loadEnvFiles(cwd: string): void {
  for (const file of [".env.local", ".env.development.local", ".env"]) {
    const path = join(cwd, file);
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(raw);
      if (!m) continue;
      const key = m[1]!;
      let value = m[2] ?? "";
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, "");
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

/** Upsert KEY=value into an env file; returns false when the key already exists. */
export function writeEnvVar(cwd: string, file: string, key: string, value: string, overwrite = false): boolean {
  const path = join(cwd, file);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const re = new RegExp(`^\\s*(export\\s+)?${key}\\s*=.*$`, "m");
  if (re.test(current)) {
    if (!overwrite) return false;
    writeFileSync(path, current.replace(re, `${key}=${value}`));
    return true;
  }
  const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${current}${sep}${key}=${value}\n`);
  return true;
}

export type KeyType = "secret" | "publishable";

export function generateApiKey(type: KeyType = "secret"): { key: string; hash: string; prefix: string } {
  const key = `${type === "secret" ? "kr_sk_live_" : "kr_pk_live_"}${randomBytes(32).toString("base64url").slice(0, 43)}`;
  return { key, hash: sha256(key), prefix: key.slice(0, 12) };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function redact(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.length <= 16 ? "****" : `${value.slice(0, 12)}…${value.slice(-4)}`;
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return "<invalid url>";
  }
}
