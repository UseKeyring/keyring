/**
 * Minimal Supabase Management API client (https://api.supabase.com) for the
 * one-click connect flow. Authenticated with the user's short-lived CLI-flow
 * token — held in memory for one orchestration run, never persisted.
 *
 * Surfaces used (all verified against Supabase docs):
 * - GET  /v1/projects/{ref}                       verify access
 * - POST /v1/projects/{ref}/database/query        run SQL (one statement/call)
 * - GET/PATCH /v1/projects/{ref}/postgrest         read/append exposed schemas
 * - POST /v1/projects/{ref}/functions/deploy      deploy source files
 * - POST /v1/projects/{ref}/secrets               bulk set secrets
 * - GET  /v1/projects/{ref}/secrets               verify by name (never values)
 */
import { SUPABASE_API_HOST } from "./supabase-link-crypto";

export type MgmtStep = { step: string; ok: boolean; detail?: string };

async function mgmt(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`${SUPABASE_API_HOST}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body — text carries it */
  }
  return { status: res.status, json, text };
}

function apiError(action: string, status: number, json: unknown, text: string): Error {
  const msg =
    (json as { message?: unknown } | null)?.message ?? (json as { error?: unknown } | null)?.error;
  const detail = typeof msg === "string" && msg ? msg : text.slice(0, 300);
  return new Error(`${action} failed (${status})${detail ? `: ${detail}` : ""}`);
}

export async function mgmtGetProject(token: string, ref: string): Promise<{ name: string }> {
  const { status, json, text } = await mgmt(token, `/v1/projects/${ref}`);
  if (status !== 200) throw apiError("read project (check ref + token access)", status, json, text);
  const name = (json as { name?: unknown } | null)?.name;
  return { name: typeof name === "string" ? name : ref };
}

/** One SQL statement per call. Throws with the statement index on failure. */
export async function mgmtRunQuery(token: string, ref: string, query: string): Promise<void> {
  const { status, json, text } = await mgmt(token, `/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (status < 200 || status >= 300) throw apiError("run SQL", status, json, text);
}

/**
 * Split a SQL file into executable statements. Aware of dollar-quoted bodies
 * ($$…$$), single/double-quoted strings, line + block comments — naive
 * `split(";")` would shred every trigger and function in our templates.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let dollarTag: string | null = null;
  let quote: string | null = null;
  let lineComment = false;
  let blockComment = false;
  const push = () => {
    const s = buf.trim();
    if (s) out.push(s);
    buf = "";
  };
  while (i < sql.length) {
    const c = sql[i]!;
    const next2 = sql.slice(i, i + 2);
    if (lineComment) {
      buf += c;
      if (c === "\n") lineComment = false;
      i++;
      continue;
    }
    if (blockComment) {
      buf += c;
      if (next2 === "*/") {
        buf += sql[i + 1]!;
        i += 2;
        blockComment = false;
      } else i++;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        buf += c;
        i++;
      }
      continue;
    }
    if (quote) {
      buf += c;
      if (c === quote) {
        if (sql[i + 1] === quote) {
          buf += sql[i + 1]!;
          i += 2;
        } else {
          quote = null;
          i++;
        }
      } else i++;
      continue;
    }
    if (next2 === "--") {
      lineComment = true;
      buf += c;
      i++;
      continue;
    }
    if (next2 === "/*") {
      blockComment = true;
      buf += c;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      i++;
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        dollarTag = m[0];
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === ";") {
      buf += c;
      i++;
      push();
      continue;
    }
    buf += c;
    i++;
  }
  push();
  return out;
}

/** Run a whole template file statement-by-statement. Returns executed count. */
export async function mgmtRunSqlFile(
  token: string,
  ref: string,
  sql: string,
  tolerate?: (message: string) => boolean,
): Promise<number> {
  const statements = splitSqlStatements(sql);
  let ran = 0;
  for (let n = 0; n < statements.length; n++) {
    try {
      await mgmtRunQuery(token, ref, statements[n]!);
      ran++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (tolerate?.(message)) continue;
      throw new Error(`statement ${n + 1}/${statements.length}: ${message}`);
    }
  }
  return ran;
}

export async function mgmtGetExposedSchemas(token: string, ref: string): Promise<string[]> {
  const { status, json, text } = await mgmt(token, `/v1/projects/${ref}/postgrest`);
  if (status !== 200) throw apiError("read PostgREST config", status, json, text);
  const raw = (json as { db_schema?: unknown } | null)?.db_schema;
  if (typeof raw !== "string") throw new Error("read PostgREST config failed: unexpected shape");
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function mgmtSetExposedSchemas(token: string, ref: string, schemas: string[]): Promise<void> {
  const { status, json, text } = await mgmt(token, `/v1/projects/${ref}/postgrest`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ db_schema: schemas.join(",") }),
  });
  if (status < 200 || status >= 300) throw apiError("update PostgREST config", status, json, text);
}

export type DeployFile = { name: string; content: string };

/** Deploy (create or replace) an edge function from source files. */
export async function mgmtDeployFunction(
  token: string,
  ref: string,
  slug: string,
  name: string,
  files: DeployFile[],
  verifyJwt = false,
): Promise<void> {
  const form = new FormData();
  form.set(
    "metadata",
    JSON.stringify({ name, entrypoint_path: "index.ts", verify_jwt: verifyJwt }),
  );
  for (const f of files) {
    form.append("file", new File([f.content], f.name, { type: "application/typescript" }));
  }
  const { status, json, text } = await mgmt(
    token,
    `/v1/projects/${ref}/functions/deploy?slug=${encodeURIComponent(slug)}`,
    { method: "POST", body: form },
  );
  if (status !== 200 && status !== 201) throw apiError(`deploy function ${slug}`, status, json, text);
}

export async function mgmtSetSecrets(token: string, ref: string, secrets: Record<string, string>): Promise<void> {
  const body = Object.entries(secrets).map(([name, value]) => ({ name, value }));
  const { status, json, text } = await mgmt(token, `/v1/projects/${ref}/secrets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (status !== 200 && status !== 201) throw apiError("set function secrets", status, json, text);
}

/** Verify secrets landed (names only — values are never readable back). */
export async function mgmtSecretNames(token: string, ref: string): Promise<string[]> {
  const { status, json, text } = await mgmt(token, `/v1/projects/${ref}/secrets`);
  if (status !== 200) throw apiError("list function secrets", status, json, text);
  const list = Array.isArray(json) ? json : [];
  return list
    .map((s) => (s as { name?: unknown } | null)?.name)
    .filter((n): n is string => typeof n === "string");
}
