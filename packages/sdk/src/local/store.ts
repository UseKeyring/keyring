import type { AbacCondition } from "../types.js";

export type Awaitable<T> = T | Promise<T>;

/** One grant, stored on its subject. `(role, spaceId)` is the identity. */
export type StoredGrant = {
  role: string;
  /** Space slug, or null for the platform scope (informational; identity is `spaceId`). */
  space: string | null;
  /** Stable id of the space the grant lives in (null = platform). A deleted
   *  and re-created space gets a new id, so old grants never resurrect. */
  spaceId: string | null;
  /** ISO timestamp, or null for a permanent grant. */
  expiresAt: string | null;
  /** ABAC gate; `{}` = unconditional. */
  condition: AbacCondition;
  createdAt: string;
};

/** Everything Keyring keeps about one subject — read once per check. */
export type StoredSubject = {
  displayName: string | null;
  attrs: Record<string, unknown>;
  grants: StoredGrant[];
  createdAt: string;
};

/** Runtime model changes layered over the policy (`createRole`, `createSpace`, …). */
export type RuntimeModel = {
  spaces: { id: string; slug: string; name: string; description: string | null; created_at: string }[];
  actions: { space: string | null; slug: string; name: string; category: string; description: string | null; created_at: string }[];
  roles: { space: string | null; slug: string; name: string; description: string | null; actions: string[]; created_at: string }[];
  defaults: { space: string | null; role: string | null }[];
};

/**
 * Persistence for local mode. Implement these six methods over anything —
 * Redis, Cloudflare KV, DynamoDB, a table in your own DB, `localStorage`.
 * Every method may be sync or async; with a fully synchronous store (the
 * built-in ones) `canSync()` works too.
 *
 * - `getSubject` is the hot path: one read per check. Store the whole record
 *   under one key (e.g. `keyring:subject:<id>` → JSON).
 * - Writes for one subject are serialized by the engine within a process;
 *   across processes, make `setSubject` last-writer-wins or use your store's
 *   compare-and-set.
 * - The runtime model is read once at startup (and on `reload()`) and is
 *   tiny; it only exists if you call `createRole`/`createSpace`/… at runtime.
 * - Values are plain JSON — `JSON.stringify` them as-is.
 */
export interface KeyringStore {
  getSubject(id: string): Awaitable<StoredSubject | undefined>;
  setSubject(id: string, subject: StoredSubject): Awaitable<void>;
  deleteSubject(id: string): Awaitable<void>;
  /** All subject ids — used by `exportState`, `importState` and `purgeExpiredGrants`. */
  listSubjects(): Awaitable<string[]>;
  getModel(): Awaitable<RuntimeModel | undefined>;
  setModel(model: RuntimeModel): Awaitable<void>;
}

/** Portable state: move it between stores, or into Postgres/hosted with `replayState`. */
export type KeyringSnapshot = {
  format: "keyring.local";
  version: 1;
  exportedAt: string;
  model: RuntimeModel;
  subjects: Record<string, StoredSubject>;
};

export const emptyModel = (): RuntimeModel => ({ spaces: [], actions: [], roles: [], defaults: [] });

/**
 * In-process store (the default). Fully synchronous; state lives as long as
 * the process. Values are deep-copied on the way in and out, so callers can't
 * mutate stored state by accident.
 */
export function memoryStore(initial?: Partial<Pick<KeyringSnapshot, "model" | "subjects">>): KeyringStore {
  const subjects = new Map<string, string>(Object.entries(initial?.subjects ?? {}).map(([k, v]) => [k, JSON.stringify(v)]));
  let model: string | undefined = initial?.model ? JSON.stringify(initial.model) : undefined;
  return {
    getSubject: (id) => {
      const raw = subjects.get(id);
      return raw === undefined ? undefined : (JSON.parse(raw) as StoredSubject);
    },
    setSubject: (id, s) => void subjects.set(id, JSON.stringify(s)),
    deleteSubject: (id) => void subjects.delete(id),
    listSubjects: () => [...subjects.keys()],
    getModel: () => (model === undefined ? undefined : (JSON.parse(model) as RuntimeModel)),
    setModel: (m) => void (model = JSON.stringify(m)),
  };
}
