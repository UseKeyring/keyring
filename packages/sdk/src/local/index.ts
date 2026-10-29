/**
 * Local mode — Keyring's RBAC/ABAC engine in-process. No database, no server.
 *
 *   import { createKeyring } from "@usekeyring/sdk/local";
 *   import policy from "./keyring.policy.json" with { type: "json" };
 *
 *   const keyring = createKeyring({ policy });
 *   await keyring.grantRole({ role: "editor", subject: "user_123" });
 *   await keyring.can("user_123", "docs.edit"); // true
 *
 * Same method names and result shapes as `@usekeyring/sdk/postgres` and the
 * hosted client; semantics are pinned to `drizzle/native.sql` by parity tests.
 */
export { createKeyring, LocalKeyring } from "./engine.js";
export type {
  DecisionEvent,
  ExplainedGrant,
  Explanation,
  LocalCheckOptions,
  LocalGrantInput,
  LocalKeyringOptions,
  LocalReplaceInput,
  LocalRevokeInput,
  PurgeResult,
} from "./engine.js";
export { conditionMatches } from "./condition.js";
export type { ConditionTrace, Tri } from "./condition.js";
export { definePolicy, normalizePolicy } from "./policy.js";
export type {
  ActionOf,
  ActionSpec,
  KeyringPolicy,
  NormAction,
  NormRole,
  NormScope,
  RoleOf,
  RoleSpec,
  ScopeSpec,
  SpaceOf,
  SpaceSpec,
} from "./policy.js";
export { memoryStore } from "./store.js";
export type { Awaitable, KeyringSnapshot, KeyringStore, RuntimeModel, StoredGrant, StoredSubject } from "./store.js";
export { replayState } from "./replay.js";
export type { ReplayReport, ReplayTarget } from "./replay.js";
export { BadRequestError, ForbiddenError, KeyringError, NotFoundError, UnauthorizedError } from "../errors.js";
export type {
  AbacCondition,
  CheckResult,
  GrantResult,
  Permission,
  ProvisionSubjectResult,
  Role,
  Space,
  SubjectAccess,
} from "../types.js";
