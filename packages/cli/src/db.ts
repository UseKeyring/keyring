import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqlExecutor } from "@usekeyring/sdk/postgres";
import { generateApiKey, sha256 } from "./env.js";
import { CliError } from "./output.js";

/** One connection abstraction over `pg` (real Postgres) and PGlite (local dev). */
export type Database = SqlExecutor & {
  kind: "postgres" | "local";
  /** Run a multi-statement script (no params). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
};

export async function openPostgres(url: string): Promise<Database> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  return {
    kind: "postgres",
    query: async (text, values) => {
      const res = await pool.query(text, values as unknown[] | undefined);
      return { rows: res.rows as Record<string, unknown>[] };
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

/** Embedded Postgres (WASM) persisted under `.keyring/pglite`. Single-process. */
export async function openLocal(dir: string): Promise<Database> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  mkdirSync(dir, { recursive: true });
  let db: InstanceType<typeof PGlite>;
  try {
    db = await PGlite.create({ dataDir: dir, extensions: { pgcrypto } });
  } catch (err) {
    throw new CliError(
      `Could not open the local database at ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      "local_db_locked",
      "Another `keyring` process may hold it. Stop `keyring dev`, or let the CLI talk to it (it does automatically when .keyring/dev.json is fresh).",
    );
  }
  return {
    kind: "local",
    query: async (text, values) => {
      const res = await db.query(text, values as unknown[] | undefined);
      return { rows: res.rows as Record<string, unknown>[] };
    },
    exec: async (sql) => {
      await db.exec(sql);
    },
    close: () => db.close(),
  };
}

/** The bundled native schema: dist/native.sql when built, drizzle/native.sql in the repo. */
export function schemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "native.sql"), join(here, "../../../drizzle/native.sql")]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new CliError("Bundled schema (native.sql) not found", "schema_not_bundled");
}

export function schemaVersion(): string {
  return sha256(schemaSql()).slice(0, 12);
}

export async function schemaInstalled(db: Database): Promise<boolean> {
  const { rows } = await db.query("SELECT to_regprocedure('keyring.api_check(text,text,text,jsonb,text)') IS NOT NULL AS ok");
  return rows[0]?.["ok"] === true;
}

export async function migrate(db: Database): Promise<{ applied: true; version: string }> {
  await db.exec(schemaSql());
  return { applied: true, version: schemaVersion() };
}

export async function bootstrap(
  db: Database,
  input: { slug: string; name?: string; keyName?: string },
): Promise<{ organization_id: string; slug: string; key: string; key_id: string }> {
  const { key, hash, prefix } = generateApiKey("secret");
  const { rows } = await db.query("SELECT keyring.keyring_bootstrap($1, $2, $3, $4, $5) AS r", [
    input.slug,
    input.name ?? input.slug,
    hash,
    prefix,
    input.keyName ?? "root",
  ]);
  const r = rows[0]?.["r"] as { organization_id: string; key_id: string; slug: string };
  return { ...r, key };
}

// ── local project state (.keyring/) ─────────────────────────────────────

export type LocalState = { rootKey: string; slug: string; schemaVersion: string; createdAt: string };
export type DevState = { url: string; port: number; pid: number; token: string; startedAt: string };

export const localDir = (cwd: string) => join(cwd, ".keyring");

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Open the local DB, install/upgrade the schema and bootstrap a root key on first use. */
export async function openLocalReady(cwd: string, slug = "local"): Promise<{ db: Database; state: LocalState; created: boolean }> {
  const dir = localDir(cwd);
  const db = await openLocal(join(dir, "pglite"));
  const statePath = join(dir, "local.json");
  let state = readJson<LocalState>(statePath);
  const version = schemaVersion();
  let created = false;
  if (!state || !(await schemaInstalled(db))) {
    await migrate(db);
    const boot = await bootstrap(db, { slug, name: "Local" });
    state = { rootKey: boot.key, slug: boot.slug, schemaVersion: version, createdAt: new Date().toISOString() };
    writeJson(statePath, state);
    ensureGitignore(cwd);
    created = true;
  } else if (state.schemaVersion !== version) {
    await migrate(db);
    state = { ...state, schemaVersion: version };
    writeJson(statePath, state);
  }
  return { db, state, created };
}

export function ensureGitignore(cwd: string): boolean {
  const path = join(cwd, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (/^\/?\.keyring\/?$/m.test(current)) return false;
  const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${current}${sep}\n# keyring local dev database + root key\n.keyring/\n`);
  return true;
}
