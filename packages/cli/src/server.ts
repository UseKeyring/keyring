import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { KeyringError } from "@usekeyring/sdk";
import { PostgresKeyring } from "@usekeyring/sdk/postgres";
import { AGENT_GUIDE } from "./agents.js";
import type { Admin } from "./admin.js";
import type { Database } from "./db.js";
import { toCliError } from "./output.js";
import { applyPlan, normalizePolicy, planPolicy, pullPolicy, type PolicyFile } from "./policy.js";
import { STUDIO_HTML } from "./studio.js";
import type { Api, Mode } from "./target.js";

export type ServerContext = {
  mode: Mode;
  target: string;
  db: Database;
  keyring: PostgresKeyring;
  admin: Admin;
  /** Called after the studio pushes a policy (dev mode writes it back to disk). */
  onPolicyPushed?: (policy: PolicyFile) => void;
  policyPath?: string;
  readPolicyText?: () => string | null;
};

const KEYRING_METHODS = new Set<keyof Api>([
  "check", "grantRole", "revokeRole", "replaceRole", "provisionSubject", "setSubjectAttrs", "createRole",
  "createPermission", "listRoles", "listPermissions", "track", "getSubjectAccess", "listSpaces", "createSpace",
  "deleteSpace", "createSubjectToken", "whoami",
]);
const ADMIN_METHODS = new Set<string>([
  "org", "overview", "roleDetails", "listSubjects", "subject", "events", "listKeys", "issueKey", "revokeKey",
  "setDefaultRole", "deleteRole", "deleteAction", "unlinkAction",
]);

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new KeyringError("Body too large", 413, { error: "body_too_large" });
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new KeyringError("Body must be JSON", 400, { error: "invalid_json", code: "invalid_json" });
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const text = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(text);
}

export async function startServer(ctx: ServerContext, opts: { port: number; host?: string }) {
  const token = randomBytes(24).toString("base64url");
  const host = opts.host ?? "127.0.0.1";
  const perKey = new Map<string, PostgresKeyring>();
  let boundPort = opts.port;

  const studio = {
    info: async () => ({ mode: ctx.mode, target: ctx.target, workspace: await ctx.admin.org(), policyPath: ctx.policyPath ?? null }),
    policyText: async () => ctx.readPolicyText?.() ?? null,
    pull: async () => pullPolicy(ctx.keyring, ctx.admin),
    plan: async (policy: PolicyFile, prune = false) => planPolicy(normalizePolicy(policy), ctx.keyring, ctx.admin, prune),
    push: async (policy: PolicyFile, prune = false) => {
      const scopes = normalizePolicy(policy);
      const { ops, warnings } = await planPolicy(scopes, ctx.keyring, ctx.admin, prune);
      await applyPlan(scopes, ops, ctx.keyring, ctx.admin);
      ctx.onPolicyPushed?.(policy);
      return { applied: ops.length, ops, warnings };
    },
  };

  async function rpc(body: Record<string, unknown>): Promise<unknown> {
    const target = body["target"];
    const method = String(body["method"] ?? "");
    const args = Array.isArray(body["args"]) ? body["args"] : [];
    if (target === "keyring" && KEYRING_METHODS.has(method as keyof Api)) {
      return (ctx.keyring as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);
    }
    if (target === "admin" && ADMIN_METHODS.has(method)) {
      return (ctx.admin as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);
    }
    if (target === "studio" && method in studio) {
      return (studio as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!(...args);
    }
    throw new KeyringError(`Unknown method ${String(target)}.${method}`, 404, { error: "unknown_method", code: "unknown_method" });
  }

  /** Wire-compatible subset of the hosted /api/v1 so `new Keyring({ baseUrl: "http://localhost:4983" })` just works. */
  async function api(req: IncomingMessage, url: URL): Promise<[number, unknown]> {
    const auth = req.headers.authorization ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!key) return [401, { error: "Missing Authorization: Bearer <key>", code: "unauthorized" }];
    if (key.startsWith("kr_pk_")) return [400, { error: "Publishable keys + subject tokens need the hosted API; use a secret key locally.", code: "unsupported_locally" }];
    let k = perKey.get(key);
    if (!k) {
      k = new PostgresKeyring({ database: ctx.db, apiKey: key });
      perKey.set(key, k);
    }
    const q = url.searchParams;
    const m = req.method ?? "GET";
    const b = m === "GET" ? {} : await readBody(req);
    const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const p = url.pathname.replace(/\/+$/, "");
    switch (`${m} ${p}`) {
      case "GET /api/v1/whoami":
        return [200, await k.whoami()];
      case "GET /api/v1/check": {
        const ctxParam = q.get("context");
        return [200, await k.check(q.get("subject") ?? "", q.get("permission") ?? "", { space: q.get("space") ?? undefined, context: ctxParam ? JSON.parse(ctxParam) : undefined })];
      }
      case "POST /api/v1/grants":
        return [200, await k.grantRole({ role: String(b["role"]), subject: String(b["subject"]), displayName: s(b["display_name"]), space: s(b["space"]), expiresAt: s(b["expires_at"]), ttlSeconds: typeof b["ttl_seconds"] === "number" ? b["ttl_seconds"] : undefined, condition: b["condition"] as Record<string, unknown> | undefined })];
      case "DELETE /api/v1/grants":
        return [200, await k.revokeRole({ role: String(b["role"]), subject: String(b["subject"]), space: s(b["space"]) })];
      case "POST /api/v1/subjects/provision":
        return [200, await k.provisionSubject({ subject: String(b["subject"]), displayName: s(b["display_name"]), space: s(b["space"]) })];
      case "POST /api/v1/subjects":
        return [200, await k.setSubjectAttrs({ subject: String(b["subject"]), attrs: (b["attrs"] ?? {}) as Record<string, unknown>, displayName: s(b["display_name"]) })];
      case "GET /api/v1/subjects/access":
        return [200, await k.getSubjectAccess(q.get("subject") ?? "", q.get("space") ?? undefined)];
      case "GET /api/v1/roles":
        return [200, { roles: await k.listRoles(q.get("space") ?? undefined) }];
      case "POST /api/v1/roles":
        return [201, await k.createRole({ slug: String(b["slug"]), name: String(b["name"]), description: s(b["description"]), permissions: b["permissions"] as string[] | undefined, space: s(b["space"]) })];
      case "GET /api/v1/permissions":
        return [200, { permissions: await k.listPermissions(q.get("space") ?? undefined) }];
      case "POST /api/v1/permissions":
        return [201, await k.createPermission({ slug: String(b["slug"]), name: String(b["name"]), category: s(b["category"]), description: s(b["description"]), space: s(b["space"]) })];
      case "POST /api/v1/events":
        return [200, await k.track(String(b["subject"]), String(b["permission"]), { allowed: typeof b["allowed"] === "boolean" ? b["allowed"] : undefined, context: b["context"] as Record<string, unknown> | undefined, space: s(b["space"]) })];
      case "GET /api/v1/spaces":
        return [200, { spaces: await k.listSpaces() }];
      case "POST /api/v1/spaces":
        return [201, await k.createSpace({ slug: String(b["slug"]), name: String(b["name"]), description: s(b["description"]) })];
      case "DELETE /api/v1/spaces":
        await k.deleteSpace(String(b["space"]));
        return [200, { ok: true }];
      default:
        return [404, { error: `No local route for ${m} ${p} (webhooks + subject tokens are hosted-only)`, code: "not_found" }];
    }
  }

  const server = createServer(async (req, res) => {
    // DNS-rebinding guard: only answer to loopback host names.
    const hostHeader = (req.headers.host ?? "").toLowerCase();
    const allowed = [`localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `[::1]:${boundPort}`];
    if (!allowed.includes(hostHeader)) return send(res, 421, { error: "misdirected request" });
    const url = new URL(req.url ?? "/", `http://${hostHeader}`);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return send(res, 200, STUDIO_HTML.replace("__KEYRING_TOKEN__", token), "text/html");
      }
      if (url.pathname === "/health") return send(res, 200, { ok: true, mode: ctx.mode });
      if (url.pathname === "/llms.txt") return send(res, 200, AGENT_GUIDE, "text/plain");
      if (url.pathname === "/_keyring/rpc" && req.method === "POST") {
        if (req.headers["x-keyring-token"] !== token) return send(res, 401, { ok: false, error: { code: "bad_token", message: "Missing or stale studio token — reload the page." } });
        const body = await readBody(req);
        return send(res, 200, { ok: true, result: (await rpc(body)) ?? null });
      }
      if (url.pathname.startsWith("/api/v1/")) {
        const [status, body] = await api(req, url);
        return send(res, status, body);
      }
      return send(res, 404, { error: "not found" });
    } catch (err) {
      const e = toCliError(err);
      if (url.pathname === "/_keyring/rpc") return send(res, 200, { ok: false, error: { code: e.code, message: e.message, hint: e.hint } });
      const status = err instanceof KeyringError ? err.status : 500;
      return send(res, status, { error: e.message, code: e.code });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const tryListen = (port: number, attemptsLeft: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attemptsLeft > 0) tryListen(port + 1, attemptsLeft - 1);
        else reject(err);
      });
      server.listen(port, host, () => {
        boundPort = port;
        resolve();
      });
    };
    tryListen(opts.port, 10);
  });

  return { server, token, port: boundPort, url: `http://localhost:${boundPort}` };
}

export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // headless box — the URL is printed anyway
  }
}
