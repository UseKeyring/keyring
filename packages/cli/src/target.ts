import { join } from "node:path";
import { Keyring } from "@usekeyring/sdk";
import { PostgresKeyring, type WhoAmI } from "@usekeyring/sdk/postgres";
import { Admin } from "./admin.js";
import { localDir, openLocalReady, openPostgres, readJson, type Database, type DevState, type LocalState } from "./db.js";
import { redact, redactUrl } from "./env.js";
import { CliError } from "./output.js";

/** The server-side Keyring surface shared by hosted (HTTP) and embedded (Postgres) clients. */
export type Api = Pick<
  PostgresKeyring,
  | "check"
  | "grantRole"
  | "revokeRole"
  | "replaceRole"
  | "provisionSubject"
  | "setSubjectAttrs"
  | "createRole"
  | "createPermission"
  | "listRoles"
  | "listPermissions"
  | "track"
  | "getSubjectAccess"
  | "listSpaces"
  | "createSpace"
  | "deleteSpace"
  | "createSubjectToken"
> & { whoami?: () => Promise<WhoAmI> };

export type AdminApi = Pick<Admin, keyof Admin>;

export type Mode = "local" | "postgres" | "hosted";

export type Conn = {
  mode: Mode;
  /** Human description of where calls go (credentials redacted). */
  target: string;
  keyring: Api;
  /** Operator surface — null against the hosted API (use the web console). */
  admin: AdminApi | null;
  /** Raw DB handle when this process owns the connection. */
  db: Database | null;
  apiKey: string;
  baseUrl?: string;
  close(): Promise<void>;
};

export type TargetFlags = {
  cwd: string;
  key?: string;
  databaseUrl?: string;
  baseUrl?: string;
  local?: boolean;
};

export type Resolved =
  | { mode: "hosted"; baseUrl: string; apiKey?: string }
  | { mode: "postgres"; url: string; apiKey?: string }
  | { mode: "local"; dir: string; apiKey?: string; dev: DevState | null };

/**
 * Precedence (first match wins):
 *   --local                                   → embedded local DB
 *   --base-url | KEYRING_BASE_URL             → hosted Management API
 *   --database-url | KEYRING_DATABASE_URL | DATABASE_URL → your Postgres
 *   otherwise                                 → embedded local DB (.keyring/)
 */
export function resolveTarget(flags: TargetFlags): Resolved {
  const env = process.env;
  const key = flags.key ?? env["KEYRING_SECRET_KEY"] ?? env["KEYRING_API_KEY"];
  if (!flags.local) {
    const baseUrl = flags.baseUrl ?? env["KEYRING_BASE_URL"];
    if (baseUrl) return { mode: "hosted", baseUrl, apiKey: key };
    const url = flags.databaseUrl ?? env["KEYRING_DATABASE_URL"] ?? env["DATABASE_URL"];
    if (url) return { mode: "postgres", url, apiKey: key };
  }
  const dir = localDir(flags.cwd);
  return { mode: "local", dir, apiKey: flags.key, dev: readDevState(flags.cwd) };
}

export function describeTarget(r: Resolved): string {
  if (r.mode === "hosted") return `hosted API ${r.baseUrl}`;
  if (r.mode === "postgres") return `postgres ${redactUrl(r.url)}`;
  return r.dev ? `local dev server ${r.dev.url}` : `local database ${r.dir}`;
}

function readDevState(cwd: string): DevState | null {
  const state = readJson<DevState>(join(localDir(cwd), "dev.json"));
  if (!state) return null;
  try {
    process.kill(state.pid, 0);
    return state;
  } catch {
    return null;
  }
}

/** Forward method calls to a running `keyring dev` (PGlite is single-process). */
function devProxy<T extends object>(dev: DevState, target: "keyring" | "admin"): T {
  return new Proxy({} as T, {
    get(_t, method) {
      if (typeof method !== "string" || method === "then") return undefined;
      return async (...args: unknown[]) => {
        const res = await fetch(`${dev.url}/_keyring/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-keyring-token": dev.token },
          body: JSON.stringify({ target, method, args }),
        });
        const body = (await res.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string; hint?: string } };
        if (!body.ok) throw new CliError(body.error?.message ?? "dev server error", body.error?.code ?? "error", body.error?.hint);
        return body.result;
      };
    },
  });
}

function needKey(apiKey: string | undefined, where: string): string {
  if (apiKey) return apiKey;
  throw new CliError(
    `No API key for ${where}`,
    "missing_key",
    "Set KEYRING_SECRET_KEY (or pass --key). Fresh database? `keyring migrate && keyring bootstrap` mints a root key.",
  );
}

export async function connect(flags: TargetFlags, opts: { requireKey?: boolean } = {}): Promise<Conn> {
  const r = resolveTarget(flags);
  const requireKey = opts.requireKey ?? true;

  if (r.mode === "hosted") {
    const apiKey = needKey(r.apiKey, "the hosted API");
    return {
      mode: "hosted",
      target: describeTarget(r),
      keyring: new Keyring({ apiKey, baseUrl: r.baseUrl }),
      admin: null,
      db: null,
      apiKey,
      baseUrl: r.baseUrl,
      close: async () => {},
    };
  }

  if (r.mode === "postgres") {
    const db = await openPostgres(r.url);
    const apiKey = requireKey ? needKey(r.apiKey, redactUrl(r.url)) : (r.apiKey ?? "");
    const keyring = apiKey ? new PostgresKeyring({ database: db, apiKey }) : null;
    return {
      mode: "postgres",
      target: describeTarget(r),
      keyring: keyring ?? (missingKeyApi() as Api),
      admin: keyring ? new Admin(db, keyring) : null,
      db,
      apiKey,
      close: () => db.close(),
    };
  }

  if (r.dev) {
    const state = readJson<LocalState>(join(r.dir, "local.json"));
    return {
      mode: "local",
      target: describeTarget(r),
      keyring: devProxy<Api>(r.dev, "keyring"),
      admin: devProxy<AdminApi>(r.dev, "admin"),
      db: null,
      apiKey: r.apiKey ?? state?.rootKey ?? "",
      baseUrl: r.dev.url,
      close: async () => {},
    };
  }

  const { db, state } = await openLocalReady(flags.cwd);
  const apiKey = r.apiKey ?? state.rootKey;
  const keyring = new PostgresKeyring({ database: db, apiKey });
  return {
    mode: "local",
    target: describeTarget(r),
    keyring,
    admin: new Admin(db, keyring),
    db,
    apiKey,
    close: () => db.close(),
  };
}

function missingKeyApi(): object {
  return new Proxy({}, {
    get: (_t, p) =>
      p === "then"
        ? undefined
        : () => {
            throw new CliError("This command needs an API key", "missing_key", "Set KEYRING_SECRET_KEY, or run `keyring bootstrap` to mint a root key.");
          },
  });
}

export { redact };
