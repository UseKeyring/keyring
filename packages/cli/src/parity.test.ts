/**
 * Parity: the same scenarios against
 *   (a) @usekeyring/sdk/local — the in-process engine, and
 *   (b) drizzle/native.sql inside PGlite via PostgresKeyring,
 * asserting identical results (values AND typed errors).
 *
 * Each scenario gets its own workspace (bootstrap = new org + root key) in one
 * shared PGlite, and the policy is applied with the CLI's own push code path.
 * Time: the local engine gets an injectable clock; on Postgres "advancing"
 * shifts that workspace's grant expiries back by the same amount.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PostgresKeyring } from "@usekeyring/sdk/postgres";
import { createKeyring, normalizePolicy as sdkNormalize, replayState, type KeyringPolicy } from "@usekeyring/sdk/local";
import { Admin } from "./admin.js";
import { bootstrap, migrate, type Database } from "./db.js";
import { applyPlan, normalizePolicy as cliNormalize, planPolicy, type PolicyFile } from "./policy.js";

let pg: PGlite;
let db: Database;
let n = 0;

beforeAll(async () => {
  pg = await PGlite.create({ extensions: { pgcrypto } });
  db = {
    kind: "local",
    query: async (t, v) => ({ rows: (await pg.query(t, v as unknown[])).rows as Record<string, unknown>[] }),
    exec: async (s) => void (await pg.exec(s)),
    close: () => pg.close(),
  };
  await migrate(db);
});
afterAll(() => db.close());

// Both clients expose the same method names; type them loosely for the harness.
type Client = {
  check(s: string, a: string, o?: { space?: string; context?: Record<string, unknown> }): Promise<{ allowed: boolean }>;
  grantRole(i: Record<string, unknown>): Promise<unknown>;
  revokeRole(i: Record<string, unknown>): Promise<unknown>;
  replaceRole(i: Record<string, unknown>): Promise<unknown>;
  provisionSubject(i: Record<string, unknown>): Promise<unknown>;
  setSubjectAttrs(i: Record<string, unknown>): Promise<unknown>;
  getSubjectAccess(s: string, space?: string): Promise<unknown>;
  listRoles(space?: string): Promise<Record<string, unknown>[]>;
  listPermissions(space?: string): Promise<Record<string, unknown>[]>;
  listSpaces(): Promise<Record<string, unknown>[]>;
  createRole(i: Record<string, unknown>): Promise<unknown>;
  createPermission(i: Record<string, unknown>): Promise<unknown>;
  createSpace(i: Record<string, unknown>): Promise<unknown>;
  deleteSpace(s: string): Promise<unknown>;
};

type Pair = {
  local: Client;
  remote: Client;
  /** Move both clocks forward. */
  advance(ms: number): Promise<void>;
  /** Run `op` on both, return [local, remote] outcomes (values or error shapes). */
  both(op: (k: Client) => Promise<unknown>): Promise<[unknown, unknown]>;
};

const TIMESTAMP_KEYS = new Set(["created_at", "id", "expires_at"]);
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !TIMESTAMP_KEYS.has(k)).map(([k, x]) => [k, strip(x)]));
  }
  return v;
}

async function outcome(p: Promise<unknown>): Promise<unknown> {
  try {
    return { ok: strip(await p) };
  } catch (err) {
    const e = err as { name?: string; status?: number; message?: string; body?: { code?: string } };
    return { error: e.name, status: e.status, code: e.body?.code, message: e.message };
  }
}

async function pair(policy: PolicyFile): Promise<Pair> {
  const boot = await bootstrap(db, { slug: `parity-${++n}` });
  const remote = new PostgresKeyring({ database: db, apiKey: boot.key });
  const admin = new Admin(db, remote);
  const scopes = cliNormalize(policy);
  await applyPlan(scopes, (await planPolicy(scopes, remote, admin, false)).ops, remote, admin);
  let t = Date.now();
  const local = createKeyring({ policy: policy as KeyringPolicy, now: () => t });
  const p: Pair = {
    local: local as unknown as Client,
    remote: remote as unknown as Client,
    async advance(ms) {
      t += ms;
      await db.query(
        `UPDATE keyring.grants SET expires_at = expires_at - make_interval(secs => $2::double precision / 1000)
         WHERE organization_id = $1 AND expires_at IS NOT NULL`,
        [boot.organization_id, ms],
      );
    },
    async both(op) {
      // Keep the local clock in step with Postgres' wall clock (+ advances).
      return [await outcome(op(p.local)), await outcome(op(p.remote))];
    },
  };
  return p;
}

/** Assert identical outcomes and return the (shared) value for extra checks. */
async function same(p: Pair, op: (k: Client) => Promise<unknown>): Promise<unknown> {
  const [l, r] = await p.both(op);
  expect(l).toEqual(r);
  return l;
}

const sortBy = (xs: Record<string, unknown>[]) => [...xs].sort((a, b) => String(a["slug"]).localeCompare(String(b["slug"])));

const POLICY: PolicyFile = {
  actions: {
    "docs.read": "Read docs",
    "docs.edit": { name: "Edit docs", category: "Content" },
    "docs.delete": { name: "Delete docs", category: "Danger", description: "Irreversible" },
    "billing.manage": { name: "Manage billing", category: "Billing" },
    "doc.a-b": "x",
    "doc.ab": "x",
    "doc.a_b": "x",
    "doc.a.b": "x",
    "doc.a1": "x",
  },
  roles: {
    viewer: ["docs.read"],
    editor: { name: "Editor", description: "Edits", actions: ["docs.*"] },
    admin: ["*"],
    "a-b": ["doc.a-b", "doc.ab"],
    ab: ["doc.a_b", "doc.a.b"],
    a1: ["doc.a1"],
  },
  defaultRole: "viewer",
  spaces: {
    acme: {
      name: "Acme Inc",
      description: "Tenant",
      actions: { "tickets.close": "Close tickets", "docs.read": "Read docs (acme)" },
      roles: { agent: ["tickets.close"], reader: ["docs.read"] },
      defaultRole: "agent",
    },
    globex: { actions: { "tickets.close": "Close" }, roles: { agent: ["tickets.*"] } },
  },
};

describe("parity: policy normalization", () => {
  const cases: PolicyFile[] = [
    POLICY,
    { actions: { Bad: "x", "ok.read": { name: " " } as never }, roles: { Viewer: ["nope.read"], r: ["zip.*"] }, defaultRole: "ghost" },
    { spaces: { "Bad Space": { actions: { "a.b": "x" }, roles: { r: ["*"] }, defaultRole: "r" } } },
    {},
  ];
  test.each(cases.map((c, i) => [i, c] as const))("policy #%d normalizes identically (CLI vs SDK)", (_i, c) => {
    const run = (f: (p: never) => unknown) => {
      try {
        return { ok: f(c as never) };
      } catch (e) {
        return { error: (e as Error).message.split("\n").slice(1) };
      }
    };
    expect(run(sdkNormalize)).toEqual(run(cliNormalize));
  });
});

describe("parity: RBAC", () => {
  test("model reads", async () => {
    const p = await pair(POLICY);
    for (const space of [undefined, "acme", "globex", " ACME "]) {
      const [lr, rr] = await p.both((k) => k.listRoles(space));
      expect(sortBy((lr as { ok: Record<string, unknown>[] }).ok)).toEqual(sortBy((rr as { ok: Record<string, unknown>[] }).ok));
      const [la, ra] = await p.both((k) => k.listPermissions(space));
      expect(sortBy((la as { ok: Record<string, unknown>[] }).ok)).toEqual(sortBy((ra as { ok: Record<string, unknown>[] }).ok));
    }
    await same(p, (k) => k.listSpaces());
    await same(p, (k) => k.listRoles("nope"));
  });

  test("grants, wildcards, revoke, replace, access snapshots", async () => {
    const p = await pair(POLICY);
    const actions = ["docs.read", "docs.edit", "docs.delete", "billing.manage", "doc.a-b", "doc.a.b", "nope.read", "tickets.close"];
    await same(p, (k) => k.grantRole({ role: "editor", subject: "alice", displayName: "Alice" }));
    await same(p, (k) => k.grantRole({ role: "editor", subject: "alice" })); // idempotent
    await same(p, (k) => k.grantRole({ role: "admin", subject: "root" }));
    for (const r of ["a-b", "ab", "a1"]) await same(p, (k) => k.grantRole({ role: r, subject: "sorty" }));
    for (const s of ["alice", "root", "sorty", "ghost"]) for (const a of actions) await same(p, (k) => k.check(s, a));
    for (const s of ["alice", "root", "sorty", "ghost"]) await same(p, (k) => k.getSubjectAccess(s));
    await same(p, (k) => k.replaceRole({ subject: "alice", from: "editor", to: "viewer" }));
    for (const a of actions) await same(p, (k) => k.check("alice", a));
    await same(p, (k) => k.revokeRole({ role: "viewer", subject: "alice" }));
    await same(p, (k) => k.revokeRole({ role: "viewer", subject: "never-seen" }));
    await same(p, (k) => k.check("alice", "docs.read"));
    await same(p, (k) => k.getSubjectAccess("alice"));
  });

  test("spaces: isolation both ways, no inheritance, slug normalization", async () => {
    const p = await pair(POLICY);
    await same(p, (k) => k.grantRole({ role: "admin", subject: "bob" }));
    await same(p, (k) => k.grantRole({ role: "agent", subject: "bob", space: "acme" }));
    await same(p, (k) => k.grantRole({ role: "reader", subject: "carl", space: "acme" }));
    for (const space of [undefined, "acme", "globex", " Acme ", ""]) {
      for (const a of ["tickets.close", "docs.read", "billing.manage"]) {
        await same(p, (k) => k.check("bob", a, { space }));
        await same(p, (k) => k.check("carl", a, { space }));
      }
      await same(p, (k) => k.getSubjectAccess("bob", space));
    }
    await same(p, (k) => k.grantRole({ role: "admin", subject: "bob", space: "acme" })); // platform role in a space
    await same(p, (k) => k.grantRole({ role: "agent", subject: "bob" })); // space role on platform
    await same(p, (k) => k.check("bob", "docs.read", { space: "nope" }));
    await same(p, (k) => k.revokeRole({ role: "agent", subject: "bob", space: "acme" }));
    await same(p, (k) => k.check("bob", "tickets.close", { space: "acme" }));
  });

  test("default-role provisioning per scope", async () => {
    const p = await pair(POLICY);
    await same(p, (k) => k.provisionSubject({ subject: " dora ", displayName: "Dora" }));
    await same(p, (k) => k.provisionSubject({ subject: "dora" }));
    await same(p, (k) => k.provisionSubject({ subject: "dora", space: "acme" }));
    await same(p, (k) => k.provisionSubject({ subject: "dora", space: "globex" })); // no default
    await same(p, (k) => k.provisionSubject({ subject: "  " }));
    await same(p, (k) => k.provisionSubject({ subject: "x", space: "nope" }));
    await same(p, (k) => k.check("dora", "docs.read"));
    await same(p, (k) => k.check("dora", "tickets.close", { space: "acme" }));
    const q = await pair({ actions: { "a.b": "x" }, roles: { r: ["a.b"] } });
    await same(q, (k) => k.provisionSubject({ subject: "x" }));
  });

  test("temporary grants: ttl, expiresAt, bounds, expiry, re-grant", async () => {
    const p = await pair(POLICY);
    const day = 86_400_000;
    await same(p, (k) => k.grantRole({ role: "editor", subject: "tmp", ttlSeconds: 60 }));
    await same(p, (k) => k.grantRole({ role: "admin", subject: "tmp", expiresAt: new Date(Date.now() + 10 * day) }));
    for (const ttl of [29, 30, 31536000, 31536001, 0, -5, 30.5, 1e10]) await same(p, (k) => k.grantRole({ role: "viewer", subject: "b", ttlSeconds: ttl }));
    for (const exp of [new Date(Date.now() - 1000), new Date(Date.now() + 367 * day), new Date(Date.now() + 365 * day), "not-a-date"]) {
      await same(p, (k) => k.grantRole({ role: "viewer", subject: "c", expiresAt: exp }));
    }
    await same(p, (k) => k.grantRole({ role: "viewer", subject: "d", ttlSeconds: 60, expiresAt: new Date(Date.now() - 1000) })); // ttl wins
    await same(p, (k) => k.check("tmp", "docs.edit"));
    await same(p, (k) => k.getSubjectAccess("tmp"));
    await p.advance(61_000);
    await same(p, (k) => k.check("tmp", "docs.edit")); // editor expired
    await same(p, (k) => k.check("tmp", "billing.manage")); // admin still live
    await same(p, (k) => k.getSubjectAccess("tmp"));
    await p.advance(11 * day);
    await same(p, (k) => k.check("tmp", "billing.manage"));
    await same(p, (k) => k.getSubjectAccess("tmp"));
    // provisioning onto an expired default grant is a no-op in both
    await same(p, (k) => k.grantRole({ role: "viewer", subject: "e", ttlSeconds: 30 }));
    await p.advance(31_000);
    await same(p, (k) => k.provisionSubject({ subject: "e" }));
    await same(p, (k) => k.check("e", "docs.read"));
    // re-grant without expiry makes it permanent again
    await same(p, (k) => k.grantRole({ role: "viewer", subject: "e" }));
    await same(p, (k) => k.check("e", "docs.read"));
  });

  test("validation errors and runtime model writes", async () => {
    const p = await pair(POLICY);
    await same(p, (k) => k.grantRole({ role: "ghost", subject: "x" }));
    await same(p, (k) => k.grantRole({ role: "viewer", subject: "x", space: "nope" }));
    await same(p, (k) => k.revokeRole({ role: "ghost", subject: "x" }));
    for (const slug of ["Bad Slug", "-x", "ok-role", "OK-Role", " spaced ", "", "a--b", "x_y"]) {
      await same(p, (k) => k.createRole({ slug, name: "R" }));
    }
    await same(p, (k) => k.createRole({ slug: "r2", name: "  " }));
    await same(p, (k) => k.createRole({ slug: "r3", name: "R3", permissions: ["docs.read", "no.such"] }));
    await same(p, (k) => k.createRole({ slug: "r3", name: "R3", permissions: [""] }));
    await same(p, (k) => k.createRole({ slug: "r3", name: "R3", permissions: [" docs.read "], description: " d " }));
    await same(p, (k) => k.createRole({ slug: "r3", name: "R3b", permissions: ["docs.edit"] })); // additive links
    await same(p, (k) => k.grantRole({ role: "r3", subject: "r3user" }));
    await same(p, (k) => k.getSubjectAccess("r3user"));
    await same(p, (k) => k.createRole({ slug: "viewer", name: "Viewer+", permissions: ["billing.manage"] })); // extend a policy role
    await same(p, (k) => k.grantRole({ role: "viewer", subject: "v" }));
    await same(p, (k) => k.check("v", "billing.manage"));
    for (const slug of ["docs.share", "Docs.share", "nodot", "docs.", ".docs", "a.b.c", " docs.x", "", "x_y.z-1"]) {
      await same(p, (k) => k.createPermission({ slug, name: "P", category: " Cat " }));
    }
    await same(p, (k) => k.createPermission({ slug: "docs.share", name: "" }));
    await same(p, (k) => k.createPermission({ slug: "docs.share", name: "Share v2" })); // upsert resets category
    await same(p, (k) => k.createPermission({ slug: "tickets.close", name: "x", space: "nope" }));
    await same(p, (k) => k.createRole({ slug: "agent", name: "Agent", permissions: ["docs.share"], space: "acme" })); // other scope
    const [la, ra] = await p.both((k) => k.listPermissions());
    expect(sortBy((la as { ok: Record<string, unknown>[] }).ok)).toEqual(sortBy((ra as { ok: Record<string, unknown>[] }).ok));
    const [lr, rr] = await p.both((k) => k.listRoles());
    expect(sortBy((lr as { ok: Record<string, unknown>[] }).ok)).toEqual(sortBy((rr as { ok: Record<string, unknown>[] }).ok));
    await same(p, (k) => k.setSubjectAttrs({ subject: " ", attrs: {} }));
    await same(p, (k) => k.setSubjectAttrs({ subject: "x", attrs: [] as never }));
    await same(p, (k) => k.setSubjectAttrs({ subject: "x", attrs: undefined as never }));
    await same(p, (k) => k.check("x", "docs.read", { context: [] as never }));
  });

  test("runtime spaces: create, use, delete cascades, re-create starts clean", async () => {
    const p = await pair(POLICY);
    for (const slug of ["Tenant-1", "bad slug", "", "tenant-1"]) await same(p, (k) => k.createSpace({ slug, name: "Tenant", description: " t " }));
    await same(p, (k) => k.createSpace({ slug: "x", name: " " }));
    await same(p, (k) => k.createPermission({ slug: "orders.view", name: "View", space: "tenant-1" }));
    await same(p, (k) => k.createRole({ slug: "clerk", name: "Clerk", permissions: ["orders.view"], space: "TENANT-1" }));
    await same(p, (k) => k.grantRole({ role: "clerk", subject: "u", space: "tenant-1" }));
    await same(p, (k) => k.check("u", "orders.view", { space: "tenant-1" }));
    await same(p, (k) => k.check("u", "orders.view"));
    const [ls, rs] = await p.both((k) => k.listSpaces());
    expect(ls).toEqual(rs);
    await same(p, (k) => k.deleteSpace(""));
    await same(p, (k) => k.deleteSpace("nope"));
    await same(p, (k) => k.deleteSpace("tenant-1"));
    await same(p, (k) => k.check("u", "orders.view", { space: "tenant-1" }));
    await same(p, (k) => k.createSpace({ slug: "tenant-1", name: "Again" }));
    await same(p, (k) => k.createPermission({ slug: "orders.view", name: "View", space: "tenant-1" }));
    await same(p, (k) => k.createRole({ slug: "clerk", name: "Clerk", permissions: ["orders.view"], space: "tenant-1" }));
    await same(p, (k) => k.check("u", "orders.view", { space: "tenant-1" }));
    await same(p, (k) => k.getSubjectAccess("u", "tenant-1"));
  });
});

describe("parity: ABAC condition engine", () => {
  // [condition, stored attrs, request context]
  const CASES: [unknown, Record<string, unknown>, Record<string, unknown>][] = [
    [{}, {}, {}],
    [{ attr: "plan", equals: "pro" }, { plan: "pro" }, {}],
    [{ attr: "plan", equals: "pro" }, { plan: "free" }, { plan: "pro" }],
    [{ attr: "plan", equals: "pro" }, { plan: "pro" }, { plan: "free" }],
    [{ attr: "plan", equals: "pro" }, { plan: "pro" }, { plan: null }],
    [{ attr: "plan", from: "subject", equals: "pro" }, { plan: "pro" }, { plan: "free" }],
    [{ attr: "plan", from: "context", equals: "pro" }, { plan: "pro" }, {}],
    [{ attr: "plan", from: "", equals: "pro" }, { plan: "pro" }, {}],
    [{ attr: "plan", from: "nowhere", equals: "pro" }, { plan: "pro" }, {}],
    [{ attr: "plan", from: "nowhere", equals: "pro" }, {}, {}],
    [{ attr: "n", equals: 1 }, { n: 1.0 }, {}],
    [{ attr: "n", equals: 1 }, { n: "1" }, {}],
    [{ attr: "n", equals: true }, { n: "true" }, {}],
    [{ attr: "o", equals: { a: [1, { b: 2 }] } }, { o: { a: [1, { b: 2 }] } }, {}],
    [{ attr: "o", equals: { a: [1, 2] } }, { o: { a: [2, 1] } }, {}],
    [{ attr: "o", equals: null }, { o: null }, {}],
    [{ attr: "o", equals: null }, {}, {}],
    [{ attr: "plan", in: ["pro", "enterprise"] }, { plan: "enterprise" }, {}],
    [{ attr: "plan", in: ["pro"] }, { plan: "free" }, {}],
    [{ attr: "plan", in: [] }, { plan: "free" }, {}],
    [{ attr: "plan", in: "pro" }, { plan: "pro" }, {}],
    [{ attr: "plan", in: "pro" }, {}, {}],
    [{ attr: "plan", in: null }, { plan: "pro" }, {}],
    [{ attr: "tags", in: [["a", "b"]] }, { tags: ["a", "b"] }, {}],
    [{ attr: "seats", gt: 5 }, { seats: 6 }, {}],
    [{ attr: "seats", gt: 5 }, { seats: 5 }, {}],
    [{ attr: "seats", gte: 5 }, { seats: 5 }, {}],
    [{ attr: "seats", lt: 5 }, { seats: 4.5 }, {}],
    [{ attr: "seats", lte: 5 }, { seats: 6 }, {}],
    [{ attr: "seats", gt: 5 }, { seats: "10" }, {}],
    [{ attr: "seats", gt: 5 }, { seats: " 10 " }, {}],
    [{ attr: "seats", gt: 5 }, { seats: "1e3" }, {}],
    [{ attr: "seats", gt: 5 }, { seats: "abc" }, {}],
    [{ attr: "seats", gt: 5 }, { seats: "" }, {}],
    [{ attr: "seats", gt: 5 }, { seats: true }, {}],
    [{ attr: "seats", gt: 5 }, { seats: [6] }, {}],
    [{ attr: "seats", gt: 5 }, { seats: "Infinity" }, {}],
    [{ attr: "seats", lt: 5 }, { seats: "-inf" }, {}],
    [{ attr: "seats", gt: 5 }, { seats: "NaN" }, {}],
    [{ attr: "seats", lte: 5 }, { seats: "NaN" }, {}],
    [{ attr: "seats", gt: 5 }, { seats: "1e400" }, {}],
    [{ attr: "seats", gt: "5" }, { seats: 6 }, {}],
    [{ attr: "seats", gt: "5" }, { seats: "abc" }, {}],
    [{ attr: "seats", gt: 5 }, { seats: null }, {}],
    [{ attr: "seats", gt: 5 }, {}, {}],
    [{ attr: "seats", gt: 5 }, { seats: 1 }, { seats: 9 }],
    [{ attr: "x", exists: true }, { x: 1 }, {}],
    [{ attr: "x", exists: true }, {}, {}],
    [{ attr: "x", exists: true }, { x: null }, {}],
    [{ attr: "x", exists: false }, {}, {}],
    [{ attr: "x", exists: false }, { x: 0 }, {}],
    [{ attr: "x", exists: "yes" }, { x: 1 }, {}],
    [{ attr: "x", exists: "off" }, { x: 1 }, {}],
    [{ attr: "x", exists: 1 }, {}, {}],
    [{ attr: "x", exists: null }, {}, {}],
    [{ attr: "x", exists: 2 }, {}, {}],
    [{ attr: "x", exists: "maybe" }, { x: 1 }, {}],
    [{ attr: "x", from: "context", exists: true }, { x: 1 }, {}],
    [{ attr: "", equals: 1 }, {}, {}],
    [{ attr: "  ", exists: false }, {}, {}],
    [{ attr: null, exists: false }, {}, {}],
    [{ attr: 5, equals: 1 }, { "5": 1 }, {}],
    [{ attr: "x" }, { x: 1 }, {}],
    [{ attr: "x" }, {}, {}],
    [{ attr: "x", wat: 1 }, { x: 1 }, {}],
    [{ wat: 1 }, {}, {}],
    [{ all: [] }, {}, {}],
    [{ any: [] }, {}, {}],
    [{ all: [{ attr: "a", equals: 1 }, { attr: "b", equals: 2 }] }, { a: 1, b: 2 }, {}],
    [{ all: [{ attr: "a", equals: 1 }, { attr: "b", equals: 2 }] }, { a: 1, b: 3 }, {}],
    [{ any: [{ attr: "a", equals: 9 }, { attr: "b", equals: 2 }] }, { a: 1, b: 2 }, {}],
    [{ any: [{ attr: "a", equals: 9 }, { attr: "b", equals: 9 }] }, { a: 1, b: 2 }, {}],
    [{ not: { attr: "banned", equals: true } }, { banned: true }, {}],
    [{ not: { attr: "banned", equals: true } }, {}, {}],
    [{ not: { not: { attr: "a", exists: true } } }, { a: 1 }, {}],
    [{ all: [{ attr: "n", gt: 1 }, { attr: "a", equals: 1 }] }, { n: null, a: 1 }, {}],
    [{ any: [{ attr: "n", gt: 1 }] }, { n: null }, {}],
    [{ not: { attr: "n", gt: 1 } }, { n: null }, {}],
    [{ not: { any: [{ attr: "n", gt: 1 }] } }, { n: null }, {}],
    [{ all: [{ not: { attr: "n", gt: 1 } }] }, { n: null }, {}],
    [{ not: {} }, {}, {}],
    [{ not: null }, {}, {}],
    [{ all: [null] }, {}, {}],
    [{ all: ["all"] }, {}, {}],
    [{ any: ["any"] }, {}, {}],
    [{ all: [["all"]] }, {}, {}],
    [{ not: "not" }, {}, {}],
    [{ all: null }, {}, {}],
    [{ all: { a: 1 } }, {}, {}],
    [{ any: 5 }, {}, {}],
    [{ all: [{ attr: "a", equals: 1 }], any: [] }, { a: 1 }, {}],
    [{ attr: "a", equals: 1, in: [2] }, { a: 1 }, {}],
    [{ attr: "a", in: [1], gt: 0 }, { a: 1 }, {}],
    [{ any: [{ attr: "a", wat: 1 }, { attr: "b", equals: 1 }] }, { b: 1 }, {}],
    [{ all: [{ attr: "region", in: ["eu", "us"] }, { any: [{ attr: "plan", equals: "pro" }, { attr: "seats", gte: 10 }] }, { not: { attr: "suspended", equals: true } }] }, { region: "eu", seats: 12 }, { plan: "free" }],
    [{ attr: "plan", equals: "pro" }, { plan: "pro" }, { other: { nested: [1, "x", null] } }],
  ];

  test("every case: grant-time validation + check + check after attrs", async () => {
    const p = await pair(POLICY);
    let i = 0;
    const tally = { allowed: 0, denied: 0, errors: 0 };
    const count = (o: unknown) => {
      const v = o as { ok?: { allowed?: boolean }; error?: string };
      if (v.error) tally.errors++;
      else if (v.ok?.allowed === true) tally.allowed++;
      else if (v.ok?.allowed === false) tally.denied++;
    };
    for (const [condition, attrs, context] of CASES) {
      const subject = `abac-${i++}`;
      const label = JSON.stringify({ condition, attrs, context });
      const [lg, rg] = await p.both((k) => k.grantRole({ role: "editor", subject, condition }));
      expect({ label, out: lg }).toEqual({ label, out: rg });
      const [l0, r0] = await p.both((k) => k.check(subject, "docs.edit", { context }));
      expect({ label, out: l0 }).toEqual({ label, out: r0 });
      if (Object.keys(attrs).length) await same(p, (k) => k.setSubjectAttrs({ subject, attrs }));
      const [l1, r1] = await p.both((k) => k.check(subject, "docs.edit", { context }));
      expect({ label, out: l1 }).toEqual({ label, out: r1 });
      count(lg);
      count(l1);
    }
    expect(i).toBe(CASES.length);
    // Guard against a vacuous pass (e.g. both sides failing the same way).
    expect(tally.allowed).toBeGreaterThan(25);
    expect(tally.denied).toBeGreaterThan(25);
    expect(tally.errors).toBeGreaterThan(8);
  });

  test("attrs merge shallowly and context only lives for one check", async () => {
    const p = await pair(POLICY);
    await same(p, (k) => k.grantRole({ role: "admin", subject: "m", condition: { all: [{ attr: "a", equals: 1 }, { attr: "b", equals: 2 }] } }));
    await same(p, (k) => k.setSubjectAttrs({ subject: "m", attrs: { a: 1, nested: { x: 1 } } }));
    await same(p, (k) => k.check("m", "billing.manage"));
    await same(p, (k) => k.check("m", "billing.manage", { context: { b: 2 } }));
    await same(p, (k) => k.check("m", "billing.manage"));
    await same(p, (k) => k.setSubjectAttrs({ subject: "m", attrs: { b: 2, nested: { y: 1 } } }));
    await same(p, (k) => k.check("m", "billing.manage"));
    await same(p, (k) => k.check("m", "billing.manage", { context: { a: 2 } }));
    await same(p, (k) => k.grantRole({ role: "admin", subject: "m" })); // re-grant clears the condition
    await same(p, (k) => k.check("m", "billing.manage", { context: { a: 2 } }));
  });
});

describe("parity: snapshot → replayState into Postgres", () => {
  test("a local state replayed into native.sql answers every check the same", async () => {
    const p = await pair(POLICY);
    const local = createKeyring({ policy: POLICY as KeyringPolicy });
    await local.grantRole({ role: "editor", subject: "s1", displayName: "S One" });
    await local.grantRole({ role: "agent", subject: "s1", space: "acme", ttlSeconds: 3600 });
    await local.grantRole({ role: "admin", subject: "s2", condition: { attr: "plan", in: ["pro"] } });
    await local.setSubjectAttrs({ subject: "s2", attrs: { plan: "pro" } });
    await local.createPermission({ slug: "docs.share", name: "Share" });
    await local.createRole({ slug: "sharer", name: "Sharer", permissions: ["docs.share", "docs.read"] });
    await local.grantRole({ role: "sharer" as never, subject: "s3" });
    await local.createSpace({ slug: "beta", name: "Beta" });
    await local.createPermission({ slug: "beta.use", name: "Use beta", space: "beta" });
    await local.createRole({ slug: "tester", name: "Tester", permissions: ["beta.use"], space: "beta" });
    await local.grantRole({ role: "tester", subject: "s3", space: "beta" } as never);
    const report = await replayState(await local.exportState(), p.remote as never);
    expect(report.skipped).toEqual([]);
    expect(report.grants).toBe(5);
    for (const s of ["s1", "s2", "s3", "nobody"]) {
      for (const [a, space] of [["docs.edit", undefined], ["billing.manage", undefined], ["docs.share", undefined], ["tickets.close", "acme"], ["beta.use", "beta"]] as const) {
        const l = await local.can(s, a as never, { space } as never);
        const r = (await p.remote.check(s, a, { space })).allowed;
        expect({ s, a, l }).toEqual({ s, a, l: r });
      }
      expect(strip(await local.getSubjectAccess(s))).toEqual(strip(await p.remote.getSubjectAccess(s)));
    }
  });
});
