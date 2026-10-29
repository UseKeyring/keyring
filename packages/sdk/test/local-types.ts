// Type-level tests for @usekeyring/sdk/local — compiled by `tsc -p tsconfig.typetest.json`.
// Every `@ts-expect-error` must be a real error, or tsc fails ("unused directive").
import { createKeyring, definePolicy, type ActionOf, type KeyringPolicy, type RoleOf, type SpaceOf } from "../src/local/index.js";
import jsonPolicy from "./fixture.policy.json" with { type: "json" };

const policy = {
  actions: { "invoices.read": "Read", "invoices.refund": { name: "Refund", category: "Billing" } },
  roles: { viewer: ["invoices.read"], finance: { name: "Finance", actions: ["invoices.*"] } },
  defaultRole: "viewer",
  spaces: { acme: { actions: { "tickets.close": "Close" }, roles: { agent: ["tickets.close"] } } },
} as const satisfies KeyringPolicy;

const kr = createKeyring({ policy });

async function typed() {
  await kr.check("u1", "invoices.refund");
  // @ts-expect-error typo in action slug
  await kr.check("u1", "invoices.refnud");
  // @ts-expect-error wildcard patterns are not actions
  await kr.check("u1", "invoices.*");
  await kr.check("u1", "tickets.close", { space: "acme" });
  // @ts-expect-error space action used on the platform scope
  await kr.check("u1", "tickets.close");
  // @ts-expect-error platform action used in a space (no inheritance)
  await kr.check("u1", "invoices.read", { space: "acme" });
  // @ts-expect-error unknown space
  await kr.can("u1", "invoices.read", { space: "nope" });
  await kr.grantRole({ role: "finance", subject: "u1" });
  // @ts-expect-error unknown role
  await kr.grantRole({ role: "finanse", subject: "u1" });
  await kr.grantRole({ role: "agent", subject: "u1", space: "acme" });
  // @ts-expect-error platform role in a space
  await kr.grantRole({ role: "viewer", subject: "u1", space: "acme" });
  // @ts-expect-error unknown role on revoke
  await kr.revokeRole({ role: "admin", subject: "u1" });
  const ok: boolean = kr.canSync("u1", "invoices.read");
  void ok;
  const x = await kr.explain("u1", "invoices.read");
  const allowed: boolean = x.allowed;
  void allowed;
}

// definePolicy() keeps literals without `as const`.
const kr2 = createKeyring({ policy: definePolicy({ actions: { "a.b": "x" }, roles: { r: ["a.b"] } }) });
async function defined() {
  await kr2.can("u", "a.b");
  // @ts-expect-error
  await kr2.can("u", "a.c");
}

// Inline literal is inferred too (const type parameter).
const kr3 = createKeyring({ policy: { actions: { "x.y": "x" }, roles: { r: ["x.y"] } } });
async function inline() {
  await kr3.can("u", "x.y");
  // @ts-expect-error
  await kr3.can("u", "x.z");
}

// JSON import: object keys stay literal.
const kr4 = createKeyring({ policy: jsonPolicy });
async function json() {
  await kr4.can("u", "docs.read");
  await kr4.can("u", "tickets.close", { space: "acme" });
  // @ts-expect-error
  await kr4.can("u", "docs.raed");
  await kr4.grantRole({ role: "editor", subject: "u" });
}

// Dynamic models: a policy typed as KeyringPolicy accepts any slug.
const dynamicPolicy: KeyringPolicy = { actions: {} };
const kr5 = createKeyring({ policy: dynamicPolicy });
async function dynamic(action: string, space: string) {
  await kr5.can("u", action, { space });
  await kr5.grantRole({ role: "anything", subject: "u", space });
}

// Helper types.
type P = typeof policy;
const a: ActionOf<P> = "invoices.read";
const s: SpaceOf<P> = "acme";
const r: RoleOf<P, "acme"> = "agent";
// @ts-expect-error
const bad: ActionOf<P, "acme"> = "invoices.read";
void [a, s, r, bad, typed, defined, inline, json, dynamic];
