import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PostgresKeyring } from "@usekeyring/sdk/postgres";
import { NotFoundError, UnauthorizedError } from "@usekeyring/sdk";
import { Admin } from "./admin.js";
import { bootstrap, migrate, type Database } from "./db.js";
import { parseArgv } from "./commands.js";
import { applyPlan, generateTypes, normalizePolicy, planPolicy, pullPolicy, type PolicyFile } from "./policy.js";

let pg: PGlite;
let db: Database;
let keyring: PostgresKeyring;
let admin: Admin;

const policy: PolicyFile = {
  actions: { "docs.read": "Read docs", "docs.edit": { name: "Edit docs", category: "Content" }, "billing.manage": "Manage billing" },
  roles: { viewer: ["docs.read"], editor: ["docs.*"], admin: ["*"] },
  defaultRole: "viewer",
  spaces: { acme: { actions: { "tickets.close": "Close tickets" }, roles: { agent: ["tickets.close"] } } },
};

beforeAll(async () => {
  pg = await PGlite.create({ extensions: { pgcrypto } });
  db = {
    kind: "local",
    query: async (t, v) => ({ rows: (await pg.query(t, v as unknown[])).rows as Record<string, unknown>[] }),
    exec: async (s) => void (await pg.exec(s)),
    close: () => pg.close(),
  };
  await migrate(db);
  const boot = await bootstrap(db, { slug: "test" });
  keyring = new PostgresKeyring({ database: db, apiKey: boot.key });
  admin = new Admin(db, keyring);
});

afterAll(() => db.close());

describe("policy push", () => {
  test("plans, applies, and converges to zero ops", async () => {
    const scopes = normalizePolicy(policy);
    const first = await planPolicy(scopes, keyring, admin, false);
    expect(first.ops.length).toBeGreaterThan(0);
    await applyPlan(scopes, first.ops, keyring, admin);
    const second = await planPolicy(scopes, keyring, admin, false);
    expect(second.ops).toEqual([]);
    const roles = await admin.roleDetails(null);
    expect(roles.find((r) => r.slug === "editor")?.actions).toEqual(["docs.edit", "docs.read"]);
    expect(roles.find((r) => r.slug === "viewer")?.is_default).toBe(true);
  });

  test("pull round-trips to an in-sync plan", async () => {
    const { policy: pulled } = await pullPolicy(keyring, admin);
    const plan = await planPolicy(normalizePolicy(pulled), keyring, admin, true);
    expect(plan.ops).toEqual([]);
  });

  test("prune removes what the file dropped", async () => {
    const trimmed: PolicyFile = { ...policy, roles: { viewer: ["docs.read"], editor: ["docs.read"] } };
    const scopes = normalizePolicy(trimmed);
    const plan = await planPolicy(scopes, keyring, admin, true);
    expect(plan.ops).toContainEqual({ op: "delete", kind: "role", space: null, slug: "admin" });
    expect(plan.ops).toContainEqual({ op: "unlink", kind: "role_action", space: null, slug: "editor", action: "docs.edit" });
    await applyPlan(scopes, plan.ops, keyring, admin);
    expect((await planPolicy(scopes, keyring, admin, true)).ops).toEqual([]);
    await applyPlan(normalizePolicy(policy), (await planPolicy(normalizePolicy(policy), keyring, admin, true)).ops, keyring, admin);
  });

  test("validation reports every problem with a path", () => {
    expect(() => normalizePolicy({ actions: { Bad: "x" }, roles: { viewer: ["nope.read"] }, defaultRole: "ghost" })).toThrow(/3 problem/);
  });

  test("generate emits typed unions", () => {
    const out = generateTypes(normalizePolicy(policy));
    expect(out).toContain('export const actions = ["docs.read","docs.edit","billing.manage"] as const;');
    expect(out).toContain('"acme": "tickets.close";');
  });
});

describe("embedded keyring", () => {
  test("grant → check, spaces isolated, provision uses default role", async () => {
    await keyring.grantRole({ role: "editor", subject: "alice" });
    expect((await keyring.check("alice", "docs.edit")).allowed).toBe(true);
    expect((await keyring.check("alice", "billing.manage")).allowed).toBe(false);
    await keyring.grantRole({ role: "agent", subject: "alice", space: "acme" });
    expect((await keyring.check("alice", "tickets.close", { space: "acme" })).allowed).toBe(true);
    expect((await keyring.check("alice", "docs.edit", { space: "acme" })).allowed).toBe(false);
    expect((await keyring.provisionSubject({ subject: "bob" })).role).toBe("viewer");
  });

  test("ABAC condition: context and stored attrs", async () => {
    await keyring.grantRole({ role: "admin", subject: "carol", condition: { attr: "plan", in: ["pro"] } });
    expect((await keyring.check("carol", "billing.manage")).allowed).toBe(false);
    expect((await keyring.check("carol", "billing.manage", { context: { plan: "pro" } })).allowed).toBe(true);
    await keyring.setSubjectAttrs({ subject: "carol", attrs: { plan: "pro" } });
    expect((await keyring.check("carol", "billing.manage")).allowed).toBe(true);
  });

  test("typed errors", async () => {
    await expect(keyring.grantRole({ role: "ghost", subject: "x" })).rejects.toBeInstanceOf(NotFoundError);
    const bad = new PostgresKeyring({ database: db, apiKey: "kr_sk_live_nope" });
    await expect(bad.listRoles()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("scoped keys are enforced in Postgres", async () => {
    const k = await admin.issueKey({ name: "runtime", scopes: ["check"] });
    const runtime = new PostgresKeyring({ database: db, apiKey: k.key });
    expect((await runtime.check("alice", "docs.read")).allowed).toBe(true);
    await expect(runtime.grantRole({ role: "viewer", subject: "x" })).rejects.toBeInstanceOf(UnauthorizedError);
    await admin.revokeKey(k.id);
    await expect(runtime.check("alice", "docs.read")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("admin reads: subjects, detail, events", async () => {
    expect((await admin.listSubjects({ q: "ali" })).map((s) => s["subject"])).toEqual(["alice"]);
    const detail = await admin.subject("alice");
    expect(detail?.grants.map((g) => g.role).sort()).toEqual(["agent", "editor"]);
    const denied = await admin.events({ denied: true, subject: "alice" });
    expect(denied.every((e) => e["allowed"] === false)).toBe(true);
  });
});

describe("argv", () => {
  test("flags before the command, --no-*, short flags, positionals", () => {
    const p = parseArgv(["--cwd", "/x", "events", "-f", "--no-denied", "--limit=5"]);
    expect(p.command?.name).toBe("events");
    expect(p.opts).toEqual({ cwd: "/x", follow: true, denied: false, limit: "5" });
    const q = parseArgv(["check", "u1", "a.b", "--context", '{"x":1}', "--wat"]);
    expect(q.positionals).toEqual(["u1", "a.b"]);
    expect(q.unknown).toEqual(["--wat"]);
    expect(parseArgv(["console"]).command?.name).toBe("studio");
  });
});
