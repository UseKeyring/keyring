import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import { conditionMatches } from "./condition.js";
import { jsonFileStore } from "./file-store.js";
import { createKeyring, definePolicy, memoryStore, replayState, type DecisionEvent, type KeyringStore } from "./index.js";

const policy = definePolicy({
  actions: {
    "docs.read": "Read docs",
    "docs.edit": { name: "Edit docs", category: "Content" },
    "billing.manage": { name: "Manage billing", category: "Billing" },
  },
  roles: { viewer: ["docs.read"], editor: ["docs.*"], admin: { name: "Admin", actions: ["*"] } },
  defaultRole: "viewer",
  spaces: {
    acme: { name: "Acme", actions: { "tickets.close": "Close tickets" }, roles: { agent: ["tickets.close"] }, defaultRole: "agent" },
  },
});

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
function clock() {
  let t = T0;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("rbac core", () => {
  test("grant → check, wildcards, revoke, replace", async () => {
    const kr = createKeyring({ policy });
    await kr.grantRole({ role: "editor", subject: "alice" });
    expect(await kr.can("alice", "docs.edit")).toBe(true);
    expect(await kr.can("alice", "docs.read")).toBe(true);
    expect(await kr.can("alice", "billing.manage")).toBe(false);
    expect((await kr.check("alice", "docs.edit")).space).toBeNull();
    await kr.replaceRole({ subject: "alice", from: "editor", to: "admin" });
    expect(await kr.can("alice", "billing.manage")).toBe(true);
    expect((await kr.getSubjectAccess("alice")).roles).toEqual(["admin"]);
    await kr.revokeRole({ role: "admin", subject: "alice" });
    expect(await kr.can("alice", "docs.read")).toBe(false);
    await expect(kr.assert("alice", "docs.read")).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("spaces are isolated both ways", async () => {
    const kr = createKeyring({ policy });
    await kr.grantRole({ role: "admin", subject: "bob" });
    await kr.grantRole({ role: "agent", subject: "bob", space: "acme" });
    expect(await kr.can("bob", "tickets.close", { space: "acme" })).toBe(true);
    expect(await kr.can("bob", "docs.read", { space: "acme" } as never)).toBe(false);
    expect(await kr.can("bob", "tickets.close" as never)).toBe(false);
    await expect(kr.check("bob", "docs.read", { space: "nope" } as never)).rejects.toMatchObject({ body: { code: "unknown_space" } });
    expect((await kr.getSubjectAccess("bob", "acme")).permissions).toEqual(["tickets.close"]);
  });

  test("provisioning uses the scope's default role, idempotently", async () => {
    const kr = createKeyring({ policy });
    expect(await kr.provisionSubject({ subject: " carol " })).toEqual({ subject: "carol", role: "viewer", space: null, granted: true });
    expect((await kr.provisionSubject({ subject: "carol" })).granted).toBe(false);
    expect((await kr.provisionSubject({ subject: "carol", space: "acme" })).role).toBe("agent");
    await expect(createKeyring({ policy: { actions: { "a.b": "x" } } }).provisionSubject({ subject: "x" })).rejects.toMatchObject({ body: { code: "no_default_role" } });
  });

  test("temporary grants expire with the injected clock", async () => {
    const c = clock();
    const kr = createKeyring({ policy, now: c.now });
    const r = await kr.grantRole({ role: "editor", subject: "dan", ttlSeconds: 60 });
    expect(r.expires_at).toBe("2026-01-01T00:01:00.000Z");
    expect(await kr.can("dan", "docs.edit")).toBe(true);
    c.advance(60_000);
    expect(await kr.can("dan", "docs.edit")).toBe(false);
    expect((await kr.getSubjectAccess("dan")).roles).toEqual([]);
    expect(await kr.purgeExpiredGrants()).toEqual({ purged: 1 });
  });

  test("validation errors match the database", async () => {
    const c = clock();
    const kr = createKeyring({ policy, now: c.now });
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { body?: { code?: string } }) => e.body?.code);
    await expect(kr.grantRole({ role: "ghost" as never, subject: "x" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await code(kr.grantRole({ role: "ghost" as never, subject: "x" }))).toBe("unknown_role");
    expect(await code(kr.grantRole({ role: "viewer", subject: "x", ttlSeconds: 29 }))).toBe("invalid_ttl_seconds");
    expect(await code(kr.grantRole({ role: "viewer", subject: "x", ttlSeconds: 31536001 }))).toBe("invalid_ttl_seconds");
    expect(await code(kr.grantRole({ role: "viewer", subject: "x", expiresAt: new Date(T0 - 1) }))).toBe("expires_at_must_be_future");
    expect(await code(kr.grantRole({ role: "viewer", subject: "x", expiresAt: new Date(T0 + 367 * 86400e3) }))).toBe("expires_at_too_far (max 1 year)");
    expect(await code(kr.createRole({ slug: "Bad Slug", name: "x" }))).toBe("invalid_slug");
    expect(await code(kr.createRole({ slug: "r", name: "x", permissions: ["no.such"] }))).toBe("unknown_permission");
    expect(await code(kr.createPermission({ slug: "Docs.read", name: "x" }))).toBe("invalid_slug");
    expect(await code(kr.createPermission({ slug: "docs.read", name: " " }))).toBe("invalid_name");
    await expect(kr.createPermission({ slug: "nodot", name: "x" })).rejects.toBeInstanceOf(BadRequestError);
  });

  test("runtime model: spaces, actions, roles, default role", async () => {
    const kr = createKeyring({ policy: {} as import("./policy.js").KeyringPolicy });
    await kr.createSpace({ slug: "Tenant-1", name: "Tenant 1" });
    await kr.createPermission({ slug: "orders.view", name: "View orders", space: "tenant-1" });
    expect((await kr.createRole({ slug: "Clerk", name: "Clerk", permissions: ["orders.view"], space: "tenant-1" })).slug).toBe("clerk");
    await kr.setDefaultRole({ role: "clerk", space: "tenant-1" });
    expect((await kr.provisionSubject({ subject: "u", space: "tenant-1" })).role).toBe("clerk");
    expect(await kr.can("u", "orders.view", { space: "tenant-1" })).toBe(true);
    await kr.deleteSpace("tenant-1");
    await kr.createSpace({ slug: "tenant-1", name: "Again" });
    await kr.createPermission({ slug: "orders.view", name: "View orders", space: "tenant-1" });
    await kr.createRole({ slug: "clerk", name: "Clerk", permissions: ["orders.view"], space: "tenant-1" });
    expect(await kr.can("u", "orders.view", { space: "tenant-1" })).toBe(false); // old grants never resurrect
    await expect(createKeyring({ policy }).deleteSpace("acme")).rejects.toMatchObject({ body: { code: "space_in_policy" } });
  });

  test("policy validation reports every problem", () => {
    expect(() => createKeyring({ policy: { actions: { Bad: "x" }, roles: { viewer: ["nope.read"] }, defaultRole: "ghost" } as never })).toThrow(/3 problem/);
  });
});

describe("abac", () => {
  const m = (c: unknown, attrs: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) => conditionMatches(c, attrs, ctx);
  test("operators", () => {
    expect(m({ attr: "plan", equals: "pro" }, { plan: "pro" })).toBe(true);
    expect(m({ attr: "n", equals: 1 }, { n: "1" })).toBe(false);
    expect(m({ attr: "o", equals: { a: [1, 2] } }, { o: { a: [1, 2] } })).toBe(true);
    expect(m({ attr: "plan", in: ["pro", "ent"] }, { plan: "ent" })).toBe(true);
    expect(m({ attr: "seats", gt: 5 }, { seats: 6 })).toBe(true);
    expect(m({ attr: "seats", gte: 5 }, { seats: "5" })).toBe(true);
    expect(m({ attr: "seats", lt: 5 }, { seats: "abc" })).toBe(false);
    expect(m({ attr: "seats", lte: 5 }, { seats: 5 })).toBe(true);
    expect(m({ attr: "x", exists: true }, { x: null })).toBe(true);
    expect(m({ attr: "x", exists: false })).toBe(true);
    expect(m({ attr: "x", equals: 1 })).toBe(false);
    expect(m({ attr: "x", gt: 1 }, { x: null })).toBeNull();
  });
  test("composition and three-valued logic", () => {
    expect(m({ all: [] })).toBe(true);
    expect(m({ any: [] })).toBe(false);
    expect(m({ not: { attr: "x", exists: true } })).toBe(true);
    expect(m({ all: [{ attr: "x", gt: 1 }, { attr: "y", equals: 1 }] }, { x: null, y: 1 })).toBe(true); // NULL skipped by all
    expect(m({ any: [{ attr: "x", gt: 1 }] }, { x: null })).toBe(false);
    expect(m({ not: { attr: "x", gt: 1 } }, { x: null })).toBeNull();
  });
  test("context wins over stored attrs; from pins the source", () => {
    expect(m({ attr: "plan", equals: "pro" }, { plan: "free" }, { plan: "pro" })).toBe(true);
    expect(m({ attr: "plan", from: "subject", equals: "pro" }, { plan: "free" }, { plan: "pro" })).toBe(false);
    expect(m({ attr: "plan", from: "context", equals: "free" }, { plan: "free" }, {})).toBe(false);
    expect(() => m({ attr: "plan", from: "nowhere", equals: 1 })).toThrow(/Invalid condition from/);
    expect(() => m({ attr: "plan", in: "pro" }, { plan: "pro" })).toThrow();
    expect(() => m({ attr: "plan", wat: 1 }, { plan: "pro" })).toThrow(/Invalid condition/);
  });
  test("engine: grant condition with attrs and context", async () => {
    const kr = createKeyring({ policy });
    await kr.grantRole({ role: "admin", subject: "carol", condition: { attr: "plan", in: ["pro"] } });
    expect(await kr.can("carol", "billing.manage")).toBe(false);
    expect(await kr.can("carol", "billing.manage", { context: { plan: "pro" } })).toBe(true);
    await kr.setSubjectAttrs({ subject: "carol", attrs: { plan: "pro" } });
    expect(await kr.can("carol", "billing.manage")).toBe(true);
    expect(await kr.can("carol", "billing.manage", { context: { plan: "free" } })).toBe(false);
    await expect(kr.grantRole({ role: "admin", subject: "c", condition: [] as never })).rejects.toMatchObject({ body: { code: "invalid_condition (want object)" } });
  });
});

describe("explain", () => {
  test("allow with condition trace", async () => {
    const kr = createKeyring({ policy });
    await kr.grantRole({ role: "admin", subject: "e", condition: { attr: "plan", equals: "pro" } });
    const x = await kr.explain("e", "billing.manage", { context: { plan: "pro" } });
    expect(x.allowed).toBe(true);
    expect(x.matched).toHaveLength(1);
    expect(x.matched[0]).toMatchObject({ role: "admin", conditionResult: true, granted: true, expired: false });
    expect(x.matched[0]!.trace[0]).toMatchObject({ attr: "plan", source: "context", actual: "pro" });
    expect(x.reasons.at(-1)).toBe("Decision: ALLOW");
  });
  test("deny reasons: expired, wrong scope, typo, missing role", async () => {
    const c = clock();
    const kr = createKeyring({ policy, now: c.now });
    await kr.grantRole({ role: "editor", subject: "f", ttlSeconds: 30 });
    await kr.grantRole({ role: "agent", subject: "f", space: "acme" });
    c.advance(31_000);
    const x = await kr.explain("f", "docs.edit");
    expect(x.allowed).toBe(false);
    expect(x.matched[0]).toMatchObject({ role: "editor", expired: true, conditionResult: null });
    expect(x.reasons.join("\n")).toContain("expired at");
    const y = await kr.explain("f", "tickets.close" as never);
    expect(y.reasons.join("\n")).toContain('space "acme"');
    const z = await kr.explain("f", "docs.edti" as never);
    expect(z.reasons.join("\n")).toContain('Did you mean "docs.edit"?');
    await kr.grantRole({ role: "viewer", subject: "g" });
    const w = await kr.explain("g", "billing.manage");
    expect(w.reasons.join("\n")).toContain('Roles that grant "billing.manage" in the platform scope: "admin"');
  });
});

describe("stores, snapshots, hooks", () => {
  test("onDecision mirrors check_events", async () => {
    const events: DecisionEvent[] = [];
    const kr = createKeyring({ policy, onDecision: (e) => void events.push(e) });
    await kr.grantRole({ role: "editor", subject: "h" });
    await kr.grantRole({ role: "admin", subject: "h" });
    await kr.can("h", "docs.read", { context: { ip: "1.2.3.4" } });
    await kr.can("h", "tickets.close", { space: "acme" });
    expect(events[0]).toMatchObject({ eventType: "check", subject: "h", permission: "docs.read", allowed: true, matchedRoles: ["admin", "editor"], context: { ip: "1.2.3.4" }, space: null });
    expect(events[1]).toMatchObject({ allowed: false, matchedRoles: [], space: "acme" });
    const throwing = createKeyring({ policy, onDecision: () => { throw new Error("boom"); } });
    expect(await throwing.can("h", "docs.read")).toBe(false);
  });

  test("canSync works with sync stores, refuses async ones", async () => {
    const kr = createKeyring({ policy });
    await kr.grantRole({ role: "viewer", subject: "i" });
    expect(kr.canSync("i", "docs.read")).toBe(true);
    const mem = memoryStore();
    const slow: KeyringStore = {
      getSubject: async (id) => mem.getSubject(id),
      setSubject: async (id, s) => mem.setSubject(id, s),
      deleteSubject: async (id) => mem.deleteSubject(id),
      listSubjects: async () => mem.listSubjects(),
      getModel: async () => mem.getModel(),
      setModel: async (m) => mem.setModel(m),
    };
    const akr = createKeyring({ policy, store: slow });
    await akr.grantRole({ role: "viewer", subject: "i" });
    expect(await akr.can("i", "docs.read")).toBe(true);
    expect(() => akr.canSync("i", "docs.read")).toThrow(/synchronous store/);
  });

  test("concurrent writes to one subject are serialized", async () => {
    const kr = createKeyring({ policy });
    await Promise.all([
      kr.grantRole({ role: "viewer", subject: "j" }),
      kr.grantRole({ role: "editor", subject: "j" }),
      kr.setSubjectAttrs({ subject: "j", attrs: { a: 1 } }),
      kr.grantRole({ role: "admin", subject: "j" }),
    ]);
    expect((await kr.getSubjectAccess("j")).roles).toEqual(["admin", "editor", "viewer"]);
  });

  test("jsonFileStore persists atomically and reloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keyring-local-"));
    const path = join(dir, "state", "keyring.json");
    const a = createKeyring({ policy, store: jsonFileStore(path) });
    await a.grantRole({ role: "editor", subject: "k", condition: { attr: "team", equals: "x" } });
    await a.setSubjectAttrs({ subject: "k", attrs: { team: "x" } });
    await a.createSpace({ slug: "beta", name: "Beta" });
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.format).toBe("keyring.local");
    const b = createKeyring({ policy, store: jsonFileStore(path) });
    expect(b.canSync("k", "docs.edit")).toBe(true);
    expect((await b.listSpaces()).map((s) => s.slug)).toEqual(["acme", "beta"]);
  });

  test("export → import round-trips; replayState copies into another keyring", async () => {
    const a = createKeyring({ policy });
    await a.grantRole({ role: "editor", subject: "l", displayName: "L" });
    await a.grantRole({ role: "agent", subject: "l", space: "acme", ttlSeconds: 3600 });
    await a.setSubjectAttrs({ subject: "l", attrs: { plan: "pro" } });
    await a.createPermission({ slug: "docs.share", name: "Share" });
    await a.createRole({ slug: "sharer", name: "Sharer", permissions: ["docs.share"] });
    await a.grantRole({ role: "sharer" as never, subject: "l", condition: { attr: "plan", equals: "pro" } });
    const snap = await a.exportState();
    const b = createKeyring({ policy });
    await b.grantRole({ role: "viewer", subject: "stale" });
    await b.importState(snap);
    expect(await b.exportState().then((s) => Object.keys(s.subjects))).toEqual(["l"]);
    expect(await b.can("l", "docs.share" as never)).toBe(true);
    const c = createKeyring({ policy });
    const report = await replayState(snap, c);
    expect(report).toMatchObject({ subjects: 1, grants: 3, model: 2, skipped: [] });
    expect(await c.can("l", "tickets.close", { space: "acme" })).toBe(true);
    expect(await c.can("l", "docs.share" as never)).toBe(true);
  });
});
