#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { PostgresKeyring } from "@usekeyring/sdk/postgres";
import { Admin } from "./admin.js";
import { AGENT_GUIDE, writeAgentsBlock, writeMcpConfigs, writeSkill } from "./agents.js";
import { COMMANDS, GLOBAL_OPTIONS, parseArgv, type CommandSpec } from "./commands.js";
import { ensureGitignore, localDir, migrate, openLocalReady, openPostgres, bootstrap, schemaInstalled, schemaSql, schemaVersion, writeJson, readJson, type LocalState } from "./db.js";
import { loadEnvFiles, redact, writeEnvVar } from "./env.js";
import { c, CliError, emit, fail, info, jsonMode, setJsonMode, table } from "./output.js";
import { applyPlan, generateTypes, normalizePolicy, planPolicy, POLICY_FILE, POLICY_JSON_SCHEMA, pullPolicy, readPolicy, STARTER_POLICY, type Op, type PolicyFile } from "./policy.js";
import { openBrowser, startServer } from "./server.js";
import { connect, describeTarget, resolveTarget, type Conn, type TargetFlags } from "./target.js";

const VERSION = "0.1.0";

type Opts = Record<string, string | boolean>;
type Ctx = { cwd: string; opts: Opts; args: string[]; flags: TargetFlags; cmd: CommandSpec };

const str = (o: Opts, k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
const space = (o: Opts) => str(o, "space");
const parseJson = (text: string | undefined, what: string): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("want a JSON object");
    return v as Record<string, unknown>;
  } catch (err) {
    throw new CliError(`${what} must be a JSON object: ${(err as Error).message}`, "invalid_json", `Quote it for the shell: --${what} '{"plan":"pro"}'`);
  }
};

async function withConn<T>(ctx: Ctx, fn: (conn: Conn) => Promise<T>, opts?: { requireKey?: boolean }): Promise<T> {
  const conn = await connect(ctx.flags, opts);
  try {
    return await fn(conn);
  } finally {
    await conn.close();
  }
}

function needAdmin(conn: Conn, what: string) {
  if (conn.admin) return conn.admin;
  throw new CliError(`${what} needs database access`, "needs_database", `Against the hosted API use the web console (${conn.baseUrl ?? "dashboard"}), or set DATABASE_URL for a self-hosted database.`);
}

const sym: Record<Op["op"], string> = { create: c.green("+"), link: c.green("+"), update: c.yellow("~"), set_default: c.yellow("~"), delete: c.red("-"), unlink: c.red("-") };
const describeOp = (o: Op) =>
  `${sym[o.op]} ${o.op} ${o.kind.replace("_", " ")} ${c.bold(o.slug ?? "(none)")}${"action" in o ? ` → ${o.action}` : ""}${o.space ? c.dim(` @${o.space}`) : ""}${"detail" in o && o.detail ? c.dim(`  ${o.detail}`) : ""}`;

// ── handlers ───────────────────────────────────────────────────────────

const handlers: Record<string, (ctx: Ctx) => Promise<void>> = {
  async init({ cwd, opts }) {
    const policyPath = join(cwd, POLICY_FILE);
    const written: Record<string, string> = {};
    if (!existsSync(policyPath)) {
      writeFileSync(policyPath, `${JSON.stringify(STARTER_POLICY, null, 2)}\n`);
      written[POLICY_FILE] = "created";
    } else written[POLICY_FILE] = "exists";
    written[".gitignore"] = ensureGitignore(cwd) ? "added .keyring/" : "ok";
    if (opts["agents"] !== false) {
      written["AGENTS.md"] = writeAgentsBlock(cwd);
      written[".claude/skills/keyring/SKILL.md"] = writeSkill(cwd);
    }
    if (opts["mcp"] !== false) for (const m of writeMcpConfigs(cwd)) written[m.file] = m.status;
    const next = [
      "keyring dev                 # local sandbox + console, pushes the policy file",
      "keyring check user_1 projects.read",
      "keyring generate            # typed slugs for your app",
    ];
    emit({ ok: true, files: written, next }, () =>
      [
        c.bold("Keyring initialised"),
        ...Object.entries(written).map(([f, s]) => `  ${c.dim(s.padEnd(10))} ${f}`),
        "",
        c.bold("Next"),
        ...next.map((n) => `  ${n}`),
      ].join("\n"),
    );
  },

  async dev(ctx) {
    const { cwd, opts } = ctx;
    const existing = resolveTarget({ cwd, local: true });
    if (existing.mode === "local" && existing.dev) {
      emit({ ok: true, running: true, url: existing.dev.url }, () => `Already running at ${c.bold(existing.dev!.url)} (pid ${existing.dev!.pid})`);
      if (opts["open"] === true) openBrowser(existing.dev.url);
      return;
    }
    if (opts["reset"]) rmSync(localDir(cwd), { recursive: true, force: true });
    const { db, state, created } = await openLocalReady(cwd);
    await serve(ctx, { mode: "local", target: describeTarget(existing), db, apiKey: state.rootKey, watch: opts["watch"] !== false, created });
  },

  async studio(ctx) {
    const r = resolveTarget(ctx.flags);
    if (r.mode === "local") return handlers["dev"]!(ctx);
    if (r.mode === "hosted") {
      const url = `${r.baseUrl.replace(/\/+$/, "")}/dashboard`;
      emit({ ok: true, url }, () => `Hosted workspace → ${c.bold(url)}`);
      if (ctx.opts["open"] !== false && process.stdout.isTTY) openBrowser(url);
      return;
    }
    const db = await openPostgres(r.url);
    if (!(await schemaInstalled(db))) throw new CliError("Keyring schema is not installed in this database", "schema_missing", "Run `keyring migrate` then `keyring bootstrap`.");
    if (!r.apiKey) throw new CliError("No API key", "missing_key", "Set KEYRING_SECRET_KEY, or `keyring bootstrap` to mint one.");
    await serve(ctx, { mode: "postgres", target: describeTarget(r), db, apiKey: r.apiKey, watch: false, created: false });
  },

  async migrate(ctx) {
    if (ctx.opts["print"]) {
      process.stdout.write(schemaSql());
      return;
    }
    const r = resolveTarget(ctx.flags);
    if (r.mode === "hosted") throw new CliError("The hosted API manages its own schema", "not_applicable", "Set DATABASE_URL to migrate a self-hosted database.");
    if (r.mode === "local") {
      if (r.dev) throw new CliError("`keyring dev` is running and owns the local DB (it migrates on start)", "local_db_busy");
      const { db, created } = await openLocalReady(ctx.cwd);
      await db.close();
      emit({ ok: true, target: describeTarget(r), version: schemaVersion(), bootstrapped: created }, () => `${c.green("✓")} local schema ${schemaVersion()} ready${created ? " (root key in .keyring/local.json)" : ""}`);
      return;
    }
    const db = await openPostgres(r.url);
    try {
      const had = await schemaInstalled(db);
      const res = await migrate(db);
      emit({ ok: true, target: describeTarget(r), ...res, upgraded: had }, () =>
        `${c.green("✓")} keyring schema ${res.version} ${had ? "upgraded" : "installed"} in ${describeTarget(r)}${had ? "" : `\n  next: ${c.bold("keyring bootstrap --slug <workspace>")}`}`,
      );
    } finally {
      await db.close();
    }
  },

  async bootstrap({ cwd, opts, flags }) {
    const r = resolveTarget(flags);
    if (r.mode !== "postgres") {
      throw new CliError(
        r.mode === "local" ? "The local database bootstraps itself (see .keyring/local.json)" : "Hosted workspaces are created in the web console",
        "not_applicable",
        r.mode === "local" ? "Just run `keyring dev`." : undefined,
      );
    }
    const pkg = readJson<{ name?: string }>(join(cwd, "package.json"));
    const slug = (str(opts, "slug") ?? pkg?.name ?? basename(cwd)).replace(/^@[^/]+\//, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    const db = await openPostgres(r.url);
    try {
      if (!(await schemaInstalled(db))) throw new CliError("Schema missing", "schema_missing", "Run `keyring migrate` first.");
      const res = await bootstrap(db, { slug, name: str(opts, "name") });
      const envFile = str(opts, "env-file") ?? ".env.local";
      const saved = envFile !== "none" && writeEnvVar(cwd, envFile, "KEYRING_SECRET_KEY", res.key);
      emit({ ok: true, ...res, savedTo: saved ? envFile : null }, () =>
        [
          `${c.green("✓")} workspace ${c.bold(res.slug)} ready`,
          `  root key  ${c.bold(res.key)}`,
          saved ? c.dim(`  saved as KEYRING_SECRET_KEY in ${envFile}`) : c.yellow(`  KEYRING_SECRET_KEY already set in ${envFile} — not overwritten. Store this key now; it is not shown again.`),
          `  next: ${c.bold("keyring push")}`,
        ].join("\n"),
      );
    } finally {
      await db.close();
    }
  },

  async push(ctx) {
    const file = resolve(ctx.cwd, ctx.args[0] ?? POLICY_FILE);
    const scopes = normalizePolicy(readPolicy(file));
    const prune = ctx.opts["prune"] === true;
    await withConn(ctx, async (conn) => {
      const { ops, warnings } = await planPolicy(scopes, conn.keyring, conn.admin, prune);
      const destructive = ops.filter((o) => o.op === "delete" || o.op === "unlink");
      const dry = ctx.opts["dry-run"] === true;
      if (!dry && destructive.length && ctx.opts["yes"] !== true) {
        if (!jsonMode) process.stdout.write(`${[c.bold("Plan"), ...ops.map(describeOp)].join("\n")}\n`);
        throw new CliError(`${destructive.length} destructive change(s) need confirmation`, "confirmation_required", "Review the plan, then re-run with --yes.", 2, { dryRun: true, ops, warnings });
      }
      if (!dry) await applyPlan(scopes, ops, conn.keyring, conn.admin);
      emit({ ok: true, target: conn.target, dryRun: dry, applied: dry ? 0 : ops.length, ops, warnings }, () =>
        [
          ops.length ? `${c.bold(dry ? "Plan" : "Applied")} ${c.dim(`→ ${conn.target}`)}` : `${c.green("✓")} in sync ${c.dim(`(${conn.target})`)}`,
          ...ops.map(describeOp),
          ...warnings.map((w) => c.dim(`! ${w}`)),
          dry && ops.length ? c.dim("\nRun without --dry-run to apply.") : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    });
  },

  async pull(ctx) {
    await withConn(ctx, async (conn) => {
      const { policy, warnings } = await pullPolicy(conn.keyring, conn.admin);
      const text = `${JSON.stringify(policy, null, 2)}\n`;
      if (ctx.opts["stdout"]) {
        process.stdout.write(text);
        return;
      }
      const file = resolve(ctx.cwd, ctx.args[0] ?? POLICY_FILE);
      if (existsSync(file) && readFileSync(file, "utf8") !== text && ctx.opts["force"] !== true) {
        throw new CliError(`${basename(file)} exists and differs from the live model`, "file_exists", "Preview with `keyring pull --stdout` or `keyring push --dry-run`; overwrite with --force.");
      }
      writeFileSync(file, text);
      emit({ ok: true, file, warnings }, () => [`${c.green("✓")} wrote ${file}`, ...warnings.map((w) => c.dim(`! ${w}`))].join("\n"));
    });
  },

  async generate({ cwd, opts, args }) {
    const scopes = normalizePolicy(readPolicy(resolve(cwd, args[0] ?? POLICY_FILE)));
    const out = resolve(cwd, str(opts, "out") ?? "keyring.gen.ts");
    writeFileSync(out, generateTypes(scopes));
    emit({ ok: true, file: out }, () => `${c.green("✓")} wrote ${out}`);
  },

  async schema() {
    process.stdout.write(`${JSON.stringify(POLICY_JSON_SCHEMA, null, 2)}\n`);
  },

  async check(ctx) {
    const [subject, action] = ctx.args;
    const context = parseJson(str(ctx.opts, "context"), "context");
    const r = await withConn(ctx, (conn) => conn.keyring.check(subject!, action!, { space: space(ctx.opts), context }));
    emit(r, () => `${r.allowed ? c.green("allowed") : c.red("denied")}  ${subject} → ${action}${r.space ? c.dim(` @${r.space}`) : ""}`);
    process.exitCode = r.allowed ? 0 : 1;
  },

  async grant(ctx) {
    const [role, subject] = ctx.args;
    const ttl = str(ctx.opts, "ttl");
    const r = await withConn(ctx, (conn) =>
      conn.keyring.grantRole({
        role: role!,
        subject: subject!,
        space: space(ctx.opts),
        displayName: str(ctx.opts, "display-name"),
        ttlSeconds: ttl ? Number(ttl) : undefined,
        expiresAt: str(ctx.opts, "expires"),
        condition: parseJson(str(ctx.opts, "condition"), "condition"),
      }),
    );
    emit(r, () => `${c.green("✓")} ${subject} now holds ${c.bold(role!)}${r.space ? c.dim(` @${r.space}`) : ""}${r.expires_at ? c.dim(` until ${r.expires_at}`) : ""}`);
  },

  async revoke(ctx) {
    const [role, subject] = ctx.args;
    const r = await withConn(ctx, (conn) => conn.keyring.revokeRole({ role: role!, subject: subject!, space: space(ctx.opts) }));
    emit({ ...r, role, subject }, () => `${c.green("✓")} revoked ${c.bold(role!)} from ${subject}`);
  },

  async provision(ctx) {
    const r = await withConn(ctx, (conn) => conn.keyring.provisionSubject({ subject: ctx.args[0]!, space: space(ctx.opts), displayName: str(ctx.opts, "display-name") }));
    emit(r, () => `${c.green("✓")} ${r.subject} → ${c.bold(r.role)}${r.granted ? "" : c.dim(" (already held)")}`);
  },

  async attrs(ctx) {
    const attrs = parseJson(ctx.args[1], "json")!;
    const r = await withConn(ctx, (conn) => conn.keyring.setSubjectAttrs({ subject: ctx.args[0]!, attrs }));
    emit(r, () => `${c.green("✓")} merged ${Object.keys(attrs).join(", ")} into ${r.subject}`);
  },

  async access(ctx) {
    const subject = ctx.args[0]!;
    const out = await withConn(ctx, async (conn) => {
      const snapshot = await conn.keyring.getSubjectAccess(subject, space(ctx.opts));
      const detail = conn.admin ? await conn.admin.subject(subject) : null;
      return { ...snapshot, space: space(ctx.opts) ?? null, exists: detail ? true : snapshot.roles.length > 0, attrs: detail?.attrs ?? null, grants: detail?.grants ?? null };
    });
    emit(out, () =>
      [
        `${c.bold(subject)}${out.space ? c.dim(` @${out.space}`) : ""}${out.exists ? "" : c.dim("  (unknown subject — no grants yet)")}`,
        `  roles    ${out.roles.join(", ") || c.dim("none")}`,
        `  actions  ${out.permissions.join(", ") || c.dim("none")}`,
        out.attrs && Object.keys(out.attrs).length ? `  attrs    ${JSON.stringify(out.attrs)}` : "",
        ...(out.grants ?? []).map(
          (g: Record<string, unknown>) =>
            `  grant    ${g["role"]}${g["space"] ? `@${g["space"]}` : ""}${g["expired"] ? c.red(" expired") : g["expires_at"] ? c.dim(` until ${new Date(String(g["expires_at"])).toISOString()}`) : ""}${g["condition"] && Object.keys(g["condition"] as object).length ? c.dim(` if ${JSON.stringify(g["condition"])}`) : ""}`,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  },

  async roles(ctx) {
    const rows = await withConn(ctx, async (conn) => (conn.admin ? conn.admin.roleDetails(space(ctx.opts)) : conn.keyring.listRoles(space(ctx.opts))));
    emit({ roles: rows }, () => table(rows as Record<string, unknown>[], conn_cols(rows, ["slug", "name", "actions", "holders", "is_default"])));
  },

  async actions(ctx) {
    const rows = await withConn(ctx, (conn) => conn.keyring.listPermissions(space(ctx.opts)));
    emit({ actions: rows }, () => table(rows as unknown as Record<string, unknown>[], ["slug", "name", "category"]));
  },

  async spaces(ctx) {
    const rows = await withConn(ctx, (conn) => conn.keyring.listSpaces());
    emit({ spaces: rows }, () => table(rows as unknown as Record<string, unknown>[], ["slug", "name", "description"]));
  },

  async subjects(ctx) {
    const rows = await withConn(ctx, (conn) => needAdmin(conn, "Listing subjects").listSubjects({ q: ctx.args[0], limit: Number(str(ctx.opts, "limit") ?? 100) }));
    emit({ subjects: rows }, () => table(rows, ["subject", "display_name", "roles"]));
  },

  async events(ctx) {
    const limit = Number(str(ctx.opts, "limit") ?? 30);
    const filter = { subject: str(ctx.opts, "subject"), denied: ctx.opts["denied"] === true };
    const line = (e: Record<string, unknown>) =>
      jsonMode
        ? JSON.stringify(e)
        : `${c.dim(new Date(String(e["created_at"])).toISOString().slice(11, 19))} ${e["allowed"] ? c.green("allow") : c.red("deny ")} ${e["subject"]} → ${e["action"]}${e["space"] ? c.dim(`@${e["space"]}`) : ""}${(e["via"] as string[] | undefined)?.length ? c.dim(` via ${(e["via"] as string[]).join(",")}`) : ""}`;
    const conn = await connect(ctx.flags);
    const admin = needAdmin(conn, "Reading events");
    try {
      const rows = await admin.events({ ...filter, limit });
      if (!ctx.opts["follow"]) {
        if (jsonMode) emit({ events: rows });
        else process.stdout.write(`${rows.length ? rows.slice().reverse().map(line).join("\n") : c.dim("(no events yet)")}\n`);
        return;
      }
      // Follow: newline-delimited JSON in json mode (one event per line).
      let last = rows[0]?.["created_at"] ? new Date(String(rows[0]["created_at"])).getTime() : 0;
      for (const e of rows.slice().reverse()) process.stdout.write(`${line(e)}\n`);
      info(c.dim("following… (ctrl-c to stop)"));
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        const fresh = (await admin.events({ ...filter, limit: 200 })).filter((e) => new Date(String(e["created_at"])).getTime() > last);
        for (const e of fresh.reverse()) {
          process.stdout.write(`${line(e)}\n`);
          last = Math.max(last, new Date(String(e["created_at"])).getTime());
        }
      }
    } finally {
      await conn.close();
    }
  },

  async keys(ctx) {
    const sub = ctx.args[0] ?? "list";
    await withConn(ctx, async (conn) => {
      const admin = needAdmin(conn, "Managing keys");
      if (sub === "list") {
        const rows = await admin.listKeys();
        emit({ keys: rows }, () => table(rows.map((k) => ({ ...k, scopes: (k["scopes"] as string[]).length >= 14 ? "all" : k["scopes"], status: k["revoked_at"] ? "revoked" : "active" })), ["name", "prefix", "key_type", "scopes", "status", "last_used_at"]));
      } else if (sub === "create") {
        const r = await admin.issueKey({ name: str(ctx.opts, "name") ?? "key", publishable: ctx.opts["publishable"] === true, scopes: str(ctx.opts, "scopes")?.split(",").map((s) => s.trim()).filter(Boolean) });
        emit(r, () => `${c.green("✓")} ${r.key_type} key ${c.bold(r.name)}\n  ${c.bold(r.key)}\n  ${c.dim(`scopes: ${r.scopes.join(", ")} — shown once, store it now`)}`);
      } else if (sub === "revoke") {
        if (!ctx.args[1]) throw new CliError("Which key?", "missing_argument", "keyring keys revoke <id|prefix|name>");
        const r = await admin.revokeKey(ctx.args[1]);
        emit({ ok: true, revoked: r }, () => `${c.green("✓")} revoked ${r.map((k) => k["name"]).join(", ")}`);
      } else throw new CliError(`Unknown keys action: ${sub}`, "unknown_subcommand", "keyring keys [list|create|revoke]");
    });
  },

  async whoami(ctx) {
    const out = await withConn(ctx, async (conn) => {
      const me = conn.keyring.whoami ? await conn.keyring.whoami() : null;
      const ws = conn.admin ? await conn.admin.org() : null;
      return { mode: conn.mode, target: conn.target, key: redact(conn.apiKey), workspace: ws, keyName: me?.name ?? null, keyType: me?.key_type ?? (conn.apiKey.startsWith("kr_pk_") ? "publishable" : "secret"), scopes: me?.scopes ?? null, expiresAt: me?.expires_at ?? null };
    });
    emit(out, () =>
      [
        `${c.bold(out.mode)} ${c.dim(out.target)}`,
        out.workspace ? `  workspace ${out.workspace.slug} ${c.dim(out.workspace.name)}` : "",
        `  key       ${out.key}${out.keyName ? c.dim(` (${out.keyName}, ${out.keyType})`) : ""}`,
        out.scopes ? `  scopes    ${out.scopes.join(", ")}` : c.dim("  scopes    (not introspectable over the hosted API)"),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  },

  async doctor(ctx) {
    type Check = { name: string; ok: boolean | null; detail: string; fix?: string };
    const checks: Check[] = [];
    const add = (name: string, ok: boolean | null, detail: string, fix?: string) => checks.push({ name, ok, detail, fix });
    const major = Number(process.versions.node.split(".")[0]);
    add("node", major >= 20, `v${process.versions.node}`, major >= 20 ? undefined : "Upgrade to Node 20+");
    const r = resolveTarget(ctx.flags);
    add("target", true, describeTarget(r));
    const policyPath = join(ctx.cwd, POLICY_FILE);
    let scopes: ReturnType<typeof normalizePolicy> | null = null;
    if (existsSync(policyPath)) {
      try {
        scopes = normalizePolicy(readPolicy(policyPath));
        add("policy", true, `${POLICY_FILE}: ${scopes.reduce((n, s) => n + s.actions.length, 0)} actions, ${scopes.reduce((n, s) => n + s.roles.length, 0)} roles, ${scopes.length - 1} spaces`);
      } catch (err) {
        add("policy", false, (err as Error).message.split("\n")[0]!, "Fix the file; `keyring push --dry-run` lists every problem");
      }
    } else add("policy", null, "no keyring.policy.json", "`keyring init` scaffolds one (optional but recommended)");
    if (r.mode === "postgres") {
      try {
        const db = await openPostgres(r.url);
        try {
          await db.query("SELECT 1");
          add("database", true, "reachable");
          const installed = await schemaInstalled(db);
          add("schema", installed, installed ? "keyring schema present" : "missing", installed ? undefined : "keyring migrate");
        } finally {
          await db.close();
        }
      } catch (err) {
        add("database", false, (err as Error).message, "Check DATABASE_URL / network / SSL (?sslmode=require)");
      }
    }
    if (checks.every((x) => x.ok !== false)) {
      try {
        await withConn(ctx, async (conn) => {
          if (conn.keyring.whoami) {
            const me = await conn.keyring.whoami();
            const missing = ["check", "grants.write", "roles.write", "actions.write"].filter((s) => !me.scopes.includes(s));
            add("key", true, `${me.name} (${me.key_type}) ${redact(conn.apiKey)}`);
            add("scopes", missing.length === 0 ? true : null, missing.length ? `missing ${missing.join(", ")} (fine for a runtime key)` : "can check + manage");
          } else {
            await conn.keyring.listRoles();
            add("key", true, `${redact(conn.apiKey)} accepted by hosted API`);
          }
          if (scopes) {
            const plan = await planPolicy(scopes, conn.keyring, conn.admin, false);
            add("drift", plan.ops.length === 0, plan.ops.length ? `${plan.ops.length} change(s) not pushed` : "database matches policy file", plan.ops.length ? "keyring push --dry-run" : undefined);
          }
        });
      } catch (err) {
        const e = err as CliError;
        add("key", false, e.message, e.hint);
      }
    }
    const healthy = checks.every((x) => x.ok !== false);
    emit({ ok: healthy, checks }, () =>
      checks.map((x) => `${x.ok === true ? c.green("✓") : x.ok === false ? c.red("✗") : c.yellow("•")} ${x.name.padEnd(9)} ${x.detail}${x.fix ? c.dim(`\n            → ${x.fix}`) : ""}`).join("\n"),
    );
    if (!healthy) process.exitCode = 2;
  },

  async mcp(ctx) {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { createServer } = await import("@keyring/mcp/server");
    const conn = await connect(ctx.flags);
    const server = createServer(conn.keyring as never);
    await server.connect(new StdioServerTransport());
    process.stderr.write(`[keyring mcp] serving ${conn.target}\n`);
  },

  async docs() {
    process.stdout.write(AGENT_GUIDE);
  },

  async commands() {
    emit({ version: VERSION, globalOptions: GLOBAL_OPTIONS, commands: COMMANDS });
  },
};

function conn_cols(rows: unknown[], cols: string[]): string[] {
  const first = rows[0] as Record<string, unknown> | undefined;
  return first ? cols.filter((col) => col in first) : cols;
}

/** Shared by `dev` (local PGlite) and `studio` (your Postgres). */
async function serve(ctx: Ctx, o: { mode: "local" | "postgres"; target: string; db: Awaited<ReturnType<typeof openPostgres>>; apiKey: string; watch: boolean; created: boolean }) {
  const { cwd, opts } = ctx;
  const keyring = new PostgresKeyring({ database: o.db, apiKey: o.apiKey });
  const admin = new Admin(o.db, keyring);
  const policyPath = join(cwd, POLICY_FILE);
  let lastPolicyText = existsSync(policyPath) ? readFileSync(policyPath, "utf8") : null;

  const pushFile = async (reason: string) => {
    if (!existsSync(policyPath)) return;
    try {
      const scopes = normalizePolicy(readPolicy(policyPath));
      const { ops, warnings } = await planPolicy(scopes, keyring, admin, false);
      await applyPlan(scopes, ops, keyring, admin);
      info(ops.length ? `${c.blue("policy")} ${reason}: ${ops.length} change(s)\n${ops.map((x) => `  ${describeOp(x)}`).join("\n")}` : `${c.blue("policy")} ${reason}: in sync`);
      for (const w of warnings) info(c.dim(`  ! ${w}`));
    } catch (err) {
      const e = err as CliError;
      info(`${c.red("policy")} ${e.message}${e.hint ? c.dim(`\n  ${e.hint}`) : ""}`);
    }
  };
  if (o.mode === "local") await pushFile(o.created ? "seeded" : "loaded");

  const srv = await startServer(
    {
      mode: o.mode,
      target: o.target,
      db: o.db,
      keyring,
      admin,
      policyPath: existsSync(policyPath) ? POLICY_FILE : undefined,
      readPolicyText: () => (existsSync(policyPath) ? readFileSync(policyPath, "utf8") : null),
      onPolicyPushed: (policy: PolicyFile) => {
        if (o.mode !== "local") return;
        lastPolicyText = `${JSON.stringify(policy, null, 2)}\n`;
        writeFileSync(policyPath, lastPolicyText);
        info(`${c.blue("policy")} saved from studio → ${POLICY_FILE}`);
      },
    },
    { port: Number(str(opts, "port") ?? 4983) },
  );

  const devFile = join(localDir(cwd), "dev.json");
  if (o.mode === "local") writeJson(devFile, { url: srv.url, port: srv.port, pid: process.pid, token: srv.token, startedAt: new Date().toISOString() });

  if (o.watch && o.mode === "local") {
    watchFile(policyPath, { interval: 400 }, () => {
      const text = existsSync(policyPath) ? readFileSync(policyPath, "utf8") : null;
      if (text === lastPolicyText) return;
      lastPolicyText = text;
      void pushFile("changed");
    });
  }

  const shutdown = async () => {
    unwatchFile(policyPath);
    if (o.mode === "local") rmSync(devFile, { force: true });
    srv.server.close();
    await o.db.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const localKey = o.mode === "local" ? readJson<LocalState>(join(localDir(cwd), "local.json"))?.rootKey : undefined;
  emit({ ok: true, mode: o.mode, url: srv.url, api: `${srv.url}/api/v1`, llms: `${srv.url}/llms.txt`, rootKey: localKey ?? null, target: o.target }, () =>
    [
      "",
      `  ${c.bold("keyring")} ${c.dim(o.mode === "local" ? "dev" : "studio")}  ${c.dim(o.target)}`,
      "",
      `  console   ${c.bold(srv.url)}`,
      `  api       ${srv.url}/api/v1   ${c.dim("(same wire format as hosted)")}`,
      localKey ? `  root key  ${localKey}   ${c.dim("(local only, in .keyring/local.json)")}` : "",
      "",
      o.mode === "local" ? c.dim(`  Other terminals: \`keyring check …\`, \`keyring grant …\` talk to this server automatically.`) : "",
      o.mode === "local" && o.watch ? c.dim(`  Watching ${POLICY_FILE} — save it to push.`) : "",
      "",
    ]
      .filter((l, i, a) => l !== "" || a[i - 1] !== "")
      .join("\n"),
  );
  const shouldOpen = opts["open"] === undefined ? Boolean(process.stdout.isTTY) && !process.env["CI"] : opts["open"] === true;
  if (shouldOpen) openBrowser(srv.url);
  await new Promise(() => {});
}

// ── help ───────────────────────────────────────────────────────────────

function help(cmd?: CommandSpec): string {
  if (cmd) {
    const usage = `keyring ${cmd.name}${(cmd.args ?? []).map((a) => (a.required ? ` <${a.name}>` : ` [${a.name}]`)).join("")}${cmd.options?.length ? " [options]" : ""}`;
    return [
      `${c.bold(usage)}`,
      "",
      `  ${cmd.summary}`,
      cmd.aliases?.length ? c.dim(`  alias: ${cmd.aliases.join(", ")}`) : "",
      ...(cmd.args?.length ? ["", c.bold("Arguments"), ...cmd.args.map((a) => `  ${a.name.padEnd(18)} ${a.description}`)] : []),
      ...(cmd.options?.length ? ["", c.bold("Options"), ...cmd.options.map((o) => `  --${o.name}${o.type === "string" ? " <v>" : ""}`.padEnd(22) + ` ${o.description}`)] : []),
      ...(cmd.exitCodes ? ["", c.bold("Exit codes"), ...Object.entries(cmd.exitCodes).map(([k, v]) => `  ${k}  ${v}`)] : []),
      "",
      c.bold("Examples"),
      ...cmd.examples.map((e) => `  ${e}`),
    ]
      .filter((l) => l !== "")
      .join("\n")
      .replace(/\n(?=[^\s])/g, "\n\n")
      .replace(/\n\n\n+/g, "\n\n");
  }
  const groups = [...new Set(COMMANDS.map((x) => x.group))];
  return [
    `${c.bold("keyring")} ${c.dim(`v${VERSION}`)} — authorization you can run anywhere`,
    "",
    ...groups.flatMap((g) => [c.bold(g), ...COMMANDS.filter((x) => x.group === g).map((x) => `  ${x.name.padEnd(11)} ${x.summary}`), ""]),
    c.bold("Global options"),
    ...GLOBAL_OPTIONS.map((o) => `  --${o.name}${o.type === "string" ? " <v>" : ""}`.padEnd(22) + ` ${o.description}`),
    "",
    c.dim("Targets: --base-url → hosted · DATABASE_URL → your Postgres · else embedded local DB (.keyring/)"),
    c.dim("Agents: `keyring commands --json` for the full manifest, `keyring docs` for the guide."),
  ].join("\n");
}

// ── main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  const { command, positionals, opts, unknown } = parsed;
  if (opts["json"] !== undefined) setJsonMode(opts["json"] === true);
  if (opts["version"]) return void process.stdout.write(`${VERSION}\n`);
  if (!command) {
    if (positionals[0]) {
      const guess = COMMANDS.find((x) => x.name.startsWith(positionals[0]!.slice(0, 3)));
      throw new CliError(`Unknown command: ${positionals[0]}`, "unknown_command", guess ? `Did you mean \`keyring ${guess.name}\`? (\`keyring --help\`)` : "`keyring --help` lists commands.");
    }
    return void process.stdout.write(`${help()}\n`);
  }
  if (opts["help"]) return void process.stdout.write(`${help(command)}\n`);
  if (unknown.length) throw new CliError(`Unknown option(s) for \`${command.name}\`: ${unknown.join(", ")}`, "unknown_option", `\`keyring ${command.name} --help\``);
  const missing = (command.args ?? []).filter((a, i) => a.required && !positionals[i]);
  if (missing.length) throw new CliError(`Missing <${missing.map((a) => a.name).join("> <")}>`, "missing_argument", `Usage: ${help(command).split("\n")[0]}`);

  const cwd = resolve(str(opts, "cwd") ?? process.cwd());
  loadEnvFiles(cwd);
  const flags: TargetFlags = { cwd, key: str(opts, "key"), databaseUrl: str(opts, "database-url"), baseUrl: str(opts, "base-url"), local: opts["local"] === true };
  await handlers[command.name]!({ cwd, opts, args: positionals, flags, cmd: command });
}

main().catch(fail);
