import { errorFromReason, ForbiddenError, KeyringError } from "../errors.js";
import type {
  AbacCondition,
  CheckResult,
  CreatePermissionInput,
  CreatePermissionResult,
  CreateRoleInput,
  CreateRoleResult,
  CreateSpaceInput,
  GrantResult,
  Permission,
  ProvisionSubjectResult,
  RevokeResult,
  Role,
  SetSubjectAttrsInput,
  SetSubjectAttrsResult,
  Space,
  SubjectAccess,
  TrackResult,
} from "../types.js";
import { conditionMatches, jsonbText, toJson, validateCondition, type ConditionTrace, type Tri } from "./condition.js";
import { ACTION_SLUG_RE, normalizePolicy, ROLE_SLUG_RE, type ActionOf, type KeyringPolicy, type NormScope, type RoleOf, type SpaceOf } from "./policy.js";
import {
  emptyModel,
  memoryStore,
  type Awaitable,
  type KeyringSnapshot,
  type KeyringStore,
  type RuntimeModel,
  type StoredGrant,
  type StoredSubject,
} from "./store.js";

// ── Public option / result types ───────────────────────────────────────

export type LocalKeyringOptions<P extends KeyringPolicy = KeyringPolicy> = {
  /** Your access model — a `keyring.policy.json` import or a literal object. */
  policy?: P;
  /** Where grants, subject attrs and runtime model changes live. Default: `memoryStore()`. */
  store?: KeyringStore;
  /** Clock override (tests, replays). Default: `Date.now`. */
  now?: () => Date | number;
  /**
   * Called after every `check`/`can`/`assert`/`track` with the same fields
   * the Postgres mode writes to `check_events`. Fire-and-forget: errors and
   * rejections are swallowed so telemetry can never break a check.
   */
  onDecision?: (event: DecisionEvent) => void | Promise<void>;
};

export type DecisionEvent = {
  eventType: "check" | "custom";
  subject: string;
  permission: string;
  /** Space slug, or null for the platform scope. */
  space: string | null;
  allowed: boolean;
  /** Roles whose grant allowed it (empty when denied). */
  matchedRoles: string[];
  context: Record<string, unknown>;
  createdAt: string;
};

export type LocalCheckOptions<S> = {
  /** Space slug, or omitted for the platform scope. */
  space?: S;
  /** ABAC request context — wins over stored subject attrs. */
  context?: Record<string, unknown>;
};

export type LocalGrantInput<P, S extends string | undefined> = {
  role: RoleOf<P, S>;
  subject: string;
  space?: S;
  displayName?: string;
  /** Absolute expiry (future, ≤ 366 days). `ttlSeconds` wins when both are set. */
  expiresAt?: Date | string;
  /** Relative expiry, 30..31536000 seconds. */
  ttlSeconds?: number;
  /** ABAC gate, e.g. `{ attr: "plan", in: ["pro"] }`. */
  condition?: AbacCondition;
};

export type LocalRevokeInput<P, S extends string | undefined> = { role: RoleOf<P, S>; subject: string; space?: S };

export type LocalReplaceInput<P, S extends string | undefined> = Omit<LocalGrantInput<P, S>, "role"> & {
  from: RoleOf<P, S>;
  to: RoleOf<P, S>;
};

export type ExplainedGrant = {
  role: string;
  expiresAt: string | null;
  expired: boolean;
  /** `null` when the grant is unconditional. */
  condition: AbacCondition | null;
  /** `true`/`false`, or `null` = not evaluated (expired) or SQL-unknown (null comparison). */
  conditionResult: boolean | null;
  /** Per-leaf evaluation: which attr, from where, compared to what. */
  trace: ConditionTrace[];
  /** This grant alone allows the action. */
  granted: boolean;
};

export type Explanation = {
  allowed: boolean;
  subject: string;
  action: string;
  /** Normalized space slug, or null for the platform scope. */
  space: string | null;
  /** Grants in this scope whose role includes the action. */
  matched: ExplainedGrant[];
  /** Human-readable, in evaluation order; last line is the decision. */
  reasons: string[];
};

export type PurgeResult = { purged: number };

// ── Internals ──────────────────────────────────────────────────────────

type CSpace = { id: string; slug: string; name: string; description: string | null; created_at: string; inPolicy: boolean };
type CRole = { slug: string; name: string; description: string | null; created_at: string; actions: Set<string> };
type CAction = { slug: string; name: string; category: string; description: string | null; created_at: string };
type CScope = {
  key: string | null; // space id, null = platform
  space: CSpace | null;
  actions: Map<string, CAction>;
  roles: Map<string, CRole>;
  defaultRole: string | null;
};
type Compiled = { platform: CScope; spaces: Map<string, CScope> };

const btrim = (s: string) => s.replace(/^ +| +$/g, "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPromise = <T>(v: Awaitable<T>): v is Promise<T> => typeof (v as { then?: unknown } | null)?.then === "function";
const nullIfBlank = (s: string | null | undefined) => {
  const t = btrim(s ?? "");
  return t === "" ? null : t;
};
const cmpC = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // Postgres "C" collation
const DAY = 86_400_000;

function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const h = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  h[12] = "4";
  h[16] = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Postgres would reject the parameter before the function body runs. */
function pgCastError(code: string, message: string): KeyringError {
  return new KeyringError(message, 500, { error: message, code });
}

function castInt(n: number): number {
  const t = String(n);
  if (!/^[+-]?\d+$/.test(t)) throw pgCastError("22P02", `invalid input syntax for type integer: "${t}"`);
  if (n > 2147483647 || n < -2147483648) throw pgCastError("22003", `value "${t}" is out of range for type integer`);
  return n;
}

function castTimestamp(v: Date | string): number {
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  if (Number.isNaN(t)) throw pgCastError("22007", `invalid input syntax for type timestamp with time zone: "${String(v)}"`);
  return t;
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

function describeLeaf(t: ConditionTrace): string {
  const op = { exists: "exists", equals: "=", in: "in", gt: ">", gte: ">=", lt: "<", lte: "<=" }[t.op];
  const got =
    t.source === "missing" ? "missing" : `${jsonbText(t.actual)} from ${t.source === "context" ? "request context" : "subject attrs"}`;
  const res = t.result === null ? "unknown (null comparison)" : String(t.result);
  return `${t.attr} ${op} ${jsonbText(t.expected)} — got ${got} → ${res}`;
}

/**
 * Keyring in-process: the full RBAC/ABAC engine of `drizzle/native.sql`
 * evaluated in memory — no database, no server. Same method names and
 * result shapes as `PostgresKeyring` and the hosted `Keyring` client.
 */
export class LocalKeyring<P extends KeyringPolicy = KeyringPolicy> {
  readonly mode = "local" as const;
  private readonly store: KeyringStore;
  private readonly clock: () => number;
  private readonly onDecision?: LocalKeyringOptions<P>["onDecision"];
  private readonly scopes: NormScope[];
  private readonly bootAt: string;
  private overlay: RuntimeModel = emptyModel();
  private model!: Compiled;
  private loading?: Promise<void>;
  private readonly locks = new Map<string, Promise<unknown>>();
  private modelLock: Promise<unknown> = Promise.resolve();

  constructor(options: LocalKeyringOptions<P> = {}) {
    this.scopes = normalizePolicy((options.policy ?? {}) as KeyringPolicy);
    this.store = options.store ?? memoryStore();
    const now = options.now;
    this.clock = now ? () => +now() : () => Date.now();
    this.onDecision = options.onDecision;
    this.bootAt = new Date(this.clock()).toISOString();
    this.applyModel(this.store.getModel());
  }

  private applyModel(m: Awaitable<RuntimeModel | undefined>): void {
    if (isPromise(m)) {
      this.loading = m.then((v) => {
        this.overlay = v ?? emptyModel();
        this.model = this.compile();
        this.loading = undefined;
      });
      this.loading.catch(() => {});
    } else {
      this.overlay = m ?? emptyModel();
      this.model = this.compile();
    }
  }

  private async ready(): Promise<void> {
    if (this.loading) await this.loading;
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  // ── model compilation (policy ⊕ runtime overlay → indexed scopes) ──

  private compile(): Compiled {
    const o = this.overlay;
    const build = (norm: NormScope | undefined, space: CSpace | null): CScope => {
      const slug = space?.slug ?? null;
      const actions = new Map<string, CAction>();
      for (const a of norm?.actions ?? []) actions.set(a.slug, { ...a, created_at: this.bootAt });
      for (const a of o.actions) {
        if (a.space !== slug) continue;
        const prev = actions.get(a.slug);
        actions.set(a.slug, { slug: a.slug, name: a.name, category: a.category, description: a.description, created_at: prev?.created_at ?? a.created_at });
      }
      const roles = new Map<string, CRole>();
      for (const r of norm?.roles ?? []) {
        roles.set(r.slug, { slug: r.slug, name: r.name, description: r.description, created_at: this.bootAt, actions: new Set(r.actions) });
      }
      for (const r of o.roles) {
        if (r.space !== slug) continue;
        const prev = roles.get(r.slug);
        const acts = new Set(prev?.actions ?? []);
        for (const a of r.actions) if (actions.has(a)) acts.add(a);
        roles.set(r.slug, { slug: r.slug, name: r.name, description: r.description, created_at: prev?.created_at ?? r.created_at, actions: acts });
      }
      let defaultRole = norm?.defaultRole ?? null;
      const d = o.defaults.find((x) => x.space === slug);
      if (d) defaultRole = d.role;
      if (defaultRole && !roles.has(defaultRole)) defaultRole = null;
      return { key: space?.id ?? null, space, actions, roles, defaultRole };
    };
    const spaces = new Map<string, CScope>();
    for (const norm of this.scopes.slice(1)) {
      const slug = norm.space!;
      const ov = o.spaces.find((s) => s.slug === slug);
      const sp: CSpace = {
        id: ov?.id ?? `policy:${slug}`,
        slug,
        name: ov?.name ?? norm.spaceName ?? slug,
        description: ov ? ov.description : (norm.spaceDescription ?? null),
        created_at: this.bootAt,
        inPolicy: true,
      };
      spaces.set(slug, build(norm, sp));
    }
    for (const s of o.spaces) {
      if (spaces.has(s.slug)) continue;
      spaces.set(s.slug, build(undefined, { ...s, inPolicy: false }));
    }
    return { platform: build(this.scopes[0], null), spaces };
  }

  /** `_resolve_space_id`: null/blank → platform; unknown slug → `unknown_space`. */
  private scope(space: string | null | undefined): CScope {
    if (space === null || space === undefined || btrim(space) === "") return this.model.platform;
    const found = this.model.spaces.get(btrim(space).toLowerCase());
    if (!found) throw errorFromReason(`unknown_space:${btrim(space)}`);
    return found;
  }

  private scopeName(s: CScope): string {
    return s.space ? `space "${s.space.slug}"` : "the platform scope";
  }

  private async saveModel(mutate: (m: RuntimeModel) => void): Promise<void> {
    mutate(this.overlay);
    this.model = this.compile();
    const snapshot = toJson(this.overlay);
    const run = this.modelLock.then(() => this.store.setModel(snapshot));
    this.modelLock = run.catch(() => {});
    await run;
  }

  /** Serialized read-modify-write of one subject record. */
  private mutate<T>(id: string, fn: (rec: StoredSubject | undefined) => { next?: StoredSubject | null; result: T }): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(async () => {
      const rec = await this.store.getSubject(id);
      const { next, result } = fn(rec);
      if (next) await this.store.setSubject(id, next);
      return result;
    });
    const tail = run.then(
      () => {},
      () => {},
    );
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  private ensureSubject(rec: StoredSubject | undefined, displayName?: string | null): StoredSubject {
    const out = rec ?? { displayName: null, attrs: {}, grants: [], createdAt: this.nowIso() };
    const dn = displayName === undefined || displayName === null || displayName === "" ? null : displayName;
    if (dn !== null) out.displayName = dn;
    return out;
  }

  private context(ctx: unknown): Record<string, unknown> {
    const c = toJson(ctx ?? {});
    if (!isObj(c)) throw errorFromReason("invalid_context (want object)");
    return c;
  }

  private live(g: StoredGrant, now: number): boolean {
    return g.expiresAt === null || Date.parse(g.expiresAt) > now;
  }

  // ── decisions ─────────────────────────────────────────────────────────

  /** Pure evaluation: O(grants held by the subject). */
  private evaluate(scope: CScope, rec: StoredSubject | undefined, action: string, ctx: Record<string, unknown>, collect: boolean) {
    const matched: string[] = [];
    let allowed = false;
    if (!rec) return { allowed, matched };
    const now = this.clock();
    for (const g of rec.grants) {
      if (g.spaceId !== scope.key) continue;
      const role = scope.roles.get(g.role);
      if (!role || !role.actions.has(action) || !this.live(g, now)) continue;
      if (conditionMatches(g.condition, rec.attrs, ctx) !== true) continue;
      allowed = true;
      if (!collect) break;
      matched.push(role.slug);
    }
    return { allowed, matched: [...new Set(matched)].sort(cmpC) };
  }

  private emit(eventType: DecisionEvent["eventType"], subject: string, permission: string, scope: CScope, allowed: boolean, matched: string[], context: Record<string, unknown>) {
    if (!this.onDecision) return;
    try {
      const r = this.onDecision({
        eventType,
        subject,
        permission,
        space: scope.space?.slug ?? null,
        allowed,
        matchedRoles: allowed ? matched : [],
        context,
        createdAt: this.nowIso(),
      });
      if (isPromise(r)) r.catch(() => {});
    } catch {
      /* telemetry never breaks a check */
    }
  }

  private decide(subject: string, action: string, rec: StoredSubject | undefined, ctx: Record<string, unknown>, scope: CScope): boolean {
    const { allowed, matched } = this.evaluate(scope, rec, action, ctx, this.onDecision !== undefined);
    this.emit("check", subject, action, scope, allowed, matched, ctx);
    return allowed;
  }

  /** Is `subject` allowed `action` (in `space`, with request `context`)? */
  async check<S extends SpaceOf<P> | undefined = undefined>(subject: string, action: ActionOf<P, S>, opts?: LocalCheckOptions<S>): Promise<CheckResult> {
    await this.ready();
    const ctx = this.context(opts?.context);
    const scope = this.scope(opts?.space);
    const rec = await this.store.getSubject(subject);
    const allowed = this.decide(subject, action, rec, ctx, scope);
    return { subject, permission: action, space: opts?.space ?? null, allowed };
  }

  /** Boolean shortcut for `check()`. */
  async can<S extends SpaceOf<P> | undefined = undefined>(subject: string, action: ActionOf<P, S>, opts?: LocalCheckOptions<S>): Promise<boolean> {
    return (await this.check<S>(subject, action, opts)).allowed;
  }

  /**
   * Synchronous `can()` for render paths and hot loops. Requires a
   * synchronous store (`memoryStore`, `jsonFileStore`); throws otherwise.
   */
  canSync<S extends SpaceOf<P> | undefined = undefined>(subject: string, action: ActionOf<P, S>, opts?: LocalCheckOptions<S>): boolean {
    if (this.loading) throw new Error("canSync(): the store is still loading the model — await keyring.can() once first, or use a synchronous store.");
    const ctx = this.context(opts?.context);
    const scope = this.scope(opts?.space);
    const rec = this.store.getSubject(subject);
    if (isPromise(rec)) throw new Error("canSync() needs a synchronous store (memoryStore / jsonFileStore). Use `await keyring.can()` instead.");
    return this.decide(subject, action, rec, ctx, scope);
  }

  /** Like `check()`, but throws `ForbiddenError` on deny. */
  async assert<S extends SpaceOf<P> | undefined = undefined>(subject: string, action: ActionOf<P, S>, opts?: LocalCheckOptions<S>): Promise<CheckResult> {
    const result = await this.check<S>(subject, action, opts);
    if (!result.allowed) throw new ForbiddenError(`Permission denied: ${action} for subject ${subject}`);
    return result;
  }

  /** Why is this allowed or denied? Same evaluation as `check()`, fully traced. Does not emit `onDecision`. */
  async explain<S extends SpaceOf<P> | undefined = undefined>(subject: string, action: ActionOf<P, S>, opts?: LocalCheckOptions<S>): Promise<Explanation> {
    await this.ready();
    const ctx = this.context(opts?.context);
    const scope = this.scope(opts?.space);
    const rec = await this.store.getSubject(subject);
    const now = this.clock();
    const reasons: string[] = [];
    const where = this.scopeName(scope);
    reasons.push(
      scope.space
        ? `Scope: space "${scope.space.slug}" — isolated: only grants made in this space count (no inheritance from the platform scope).`
        : "Scope: platform — only grants made without a space count.",
    );
    if (!scope.actions.has(action)) {
      const others = [...this.model.spaces.values(), this.model.platform].filter((s) => s !== scope && s.actions.has(action)).map((s) => this.scopeName(s));
      const near = [...scope.actions.keys()].map((a) => [a, levenshtein(a, action)] as const).filter(([, d]) => d <= 2).sort((a, b) => a[1] - b[1])[0];
      reasons.push(
        `Action "${action}" is not declared in ${where}${others.length ? ` (it exists in ${others.join(", ")} — scopes don't inherit)` : ""}.${near ? ` Did you mean "${near[0]}"?` : ""}`,
      );
    }
    const matched: ExplainedGrant[] = [];
    if (!rec) {
      reasons.push(`Subject "${subject}" is unknown — no grants or attributes stored.`);
    } else {
      const held: string[] = [];
      for (const g of rec.grants) {
        if (g.spaceId !== scope.key) continue;
        const role = scope.roles.get(g.role);
        if (!role) continue;
        const expired = !this.live(g, now);
        if (!expired) held.push(role.slug);
        if (!role.actions.has(action)) continue;
        const condition = Object.keys(g.condition ?? {}).length ? g.condition : null;
        const trace: ConditionTrace[] = [];
        let conditionResult: Tri = null;
        if (!expired) conditionResult = conditionMatches(g.condition, rec.attrs, ctx, trace);
        const granted = !expired && conditionResult === true;
        matched.push({ role: role.slug, expiresAt: g.expiresAt, expired, condition, conditionResult, trace, granted });
        const head = `Role "${role.slug}" grants "${action}"`;
        if (expired) reasons.push(`${head}, but the grant expired at ${g.expiresAt}.`);
        else if (!condition) reasons.push(`${head} — ${g.expiresAt ? `temporary grant until ${g.expiresAt}` : "permanent grant"}, unconditional → allows.`);
        else {
          const leaves = trace.map(describeLeaf).join("; ");
          reasons.push(
            granted
              ? `${head} — condition ${jsonbText(condition)} holds (${leaves || "trivially"})${g.expiresAt ? `, until ${g.expiresAt}` : ""} → allows.`
              : `${head}, but its condition ${jsonbText(condition)} ${conditionResult === null ? "is unknown (null comparison) → treated as false" : "is false"}${leaves ? ` (${leaves})` : ""}.`,
          );
        }
      }
      if (matched.length === 0) {
        reasons.push(
          held.length
            ? `Subject holds ${held.map((r) => `"${r}"`).join(", ")} in ${where}; none include "${action}".`
            : `Subject holds no live roles in ${where}.`,
        );
        const would = [...scope.roles.values()].filter((r) => r.actions.has(action)).map((r) => `"${r.slug}"`);
        if (would.length) reasons.push(`Roles that grant "${action}" in ${where}: ${would.join(", ")}.`);
      }
      for (const g of rec.grants) {
        if (g.spaceId === scope.key || !this.live(g, now)) continue;
        const other = g.spaceId === null ? this.model.platform : [...this.model.spaces.values()].find((s) => s.key === g.spaceId);
        if (other?.roles.get(g.role)?.actions.has(action)) {
          reasons.push(`Note: role "${g.role}" in ${this.scopeName(other)} also grants "${action}", but does not apply here.`);
        }
      }
    }
    const allowed = matched.some((m) => m.granted);
    reasons.push(allowed ? "Decision: ALLOW" : "Decision: DENY");
    return { allowed, subject, action, space: scope.space?.slug ?? null, matched, reasons };
  }

  // ── grants ────────────────────────────────────────────────────────────

  /** Grant a role (idempotent; re-granting updates expiry + condition). Auto-creates the subject. */
  async grantRole<S extends SpaceOf<P> | undefined = undefined>(input: LocalGrantInput<P, S>): Promise<GrantResult> {
    await this.ready();
    const ttl = input.ttlSeconds != null ? castInt(input.ttlSeconds) : null;
    const absolute = ttl === null && input.expiresAt != null ? castTimestamp(input.expiresAt) : null;
    const scope = this.scope(input.space);
    const role = scope.roles.get(input.role);
    if (!role) throw errorFromReason(`unknown_role:${input.role}`);
    const condition = validateCondition(input.condition ? toJson(input.condition) : null);
    const now = this.clock();
    let exp: number | null = null;
    if (ttl !== null) {
      if (ttl < 30 || ttl > 31536000) throw errorFromReason(`invalid_ttl_seconds:${ttl} (want 30..31536000)`);
      exp = now + ttl * 1000;
    } else if (absolute !== null) {
      if (absolute <= now) throw errorFromReason("expires_at_must_be_future");
      if (absolute > now + 366 * DAY) throw errorFromReason("expires_at_too_far (max 1 year)");
      exp = absolute;
    }
    const expiresAt = exp === null ? null : new Date(exp).toISOString();
    await this.mutate(input.subject, (prev) => {
      const rec = this.ensureSubject(prev, input.displayName);
      const g = rec.grants.find((x) => x.role === role.slug && x.spaceId === scope.key);
      if (g) {
        g.expiresAt = expiresAt;
        g.condition = condition;
      } else {
        rec.grants.push({ role: role.slug, space: scope.space?.slug ?? null, spaceId: scope.key, expiresAt, condition, createdAt: this.nowIso() });
      }
      return { next: rec, result: undefined };
    });
    return {
      ok: true,
      role: input.role,
      subject: input.subject,
      space: input.space ?? null,
      expires_at: expiresAt,
      ttl_seconds: input.ttlSeconds ?? null,
      condition: input.condition ?? null,
    };
  }

  async revokeRole<S extends SpaceOf<P> | undefined = undefined>(input: LocalRevokeInput<P, S>): Promise<RevokeResult> {
    await this.ready();
    const scope = this.scope(input.space);
    if (!scope.roles.has(input.role)) throw errorFromReason(`unknown_role:${input.role}`);
    await this.mutate(input.subject, (rec) => {
      if (!rec) return { result: undefined };
      const before = rec.grants.length;
      rec.grants = rec.grants.filter((g) => !(g.role === input.role && g.spaceId === scope.key));
      return { next: rec.grants.length !== before ? rec : null, result: undefined };
    });
    return { ok: true, revoked: true };
  }

  /** Grant `to`, then revoke `from` (same as the other modes). */
  async replaceRole<S extends SpaceOf<P> | undefined = undefined>(input: LocalReplaceInput<P, S>): Promise<void> {
    const { from, to, ...rest } = input;
    await this.grantRole<S>({ ...rest, role: to } as LocalGrantInput<P, S>);
    await this.revokeRole<S>({ role: from, subject: input.subject, space: input.space } as LocalRevokeInput<P, S>);
  }

  /** Grant the scope's `defaultRole` (idempotent: `granted: false` if already held). */
  async provisionSubject(input: { subject: string; displayName?: string; space?: SpaceOf<P> }): Promise<ProvisionSubjectResult> {
    await this.ready();
    if (input.subject === null || input.subject === undefined || btrim(input.subject) === "") throw errorFromReason("invalid_subject:subject required");
    const scope = this.scope(input.space);
    if (!scope.defaultRole) throw errorFromReason("no_default_role:set one via keyring_set_default_role");
    const role = scope.defaultRole;
    const subject = btrim(input.subject);
    const granted = await this.mutate(subject, (prev) => {
      const rec = this.ensureSubject(prev, input.displayName);
      const exists = rec.grants.some((g) => g.role === role && g.spaceId === scope.key);
      if (!exists) rec.grants.push({ role, space: scope.space?.slug ?? null, spaceId: scope.key, expiresAt: null, condition: {}, createdAt: this.nowIso() });
      return { next: rec, result: !exists };
    });
    return { subject, role, space: scope.space?.slug ?? null, granted };
  }

  /** Merge (shallow) attributes used by ABAC conditions. */
  async setSubjectAttrs(input: SetSubjectAttrsInput): Promise<SetSubjectAttrsResult> {
    await this.ready();
    if (input.subject === null || input.subject === undefined || btrim(input.subject) === "") throw errorFromReason("subject_required");
    const attrs = input.attrs === undefined ? undefined : toJson(input.attrs);
    if (!isObj(attrs)) throw errorFromReason("invalid_attrs (want object)");
    await this.mutate(input.subject, (prev) => {
      const rec = this.ensureSubject(prev, input.displayName);
      rec.attrs = { ...rec.attrs, ...attrs };
      return { next: rec, result: undefined };
    });
    return { ok: true, subject: input.subject, attrs: input.attrs };
  }

  /** Live roles + their actions in one scope (conditions are not evaluated — same as Postgres). */
  async getSubjectAccess(subject: string, space?: SpaceOf<P>): Promise<SubjectAccess> {
    await this.ready();
    const scope = this.scope(space);
    const rec = await this.store.getSubject(subject);
    const roles = new Set<string>();
    const permissions = new Set<string>();
    const now = this.clock();
    for (const g of rec?.grants ?? []) {
      if (g.spaceId !== scope.key || !this.live(g, now)) continue;
      const role = scope.roles.get(g.role);
      if (!role) continue;
      roles.add(role.slug);
      for (const a of role.actions) permissions.add(a);
    }
    return { subject, space: space ?? null, roles: [...roles].sort(cmpC), permissions: [...permissions].sort(cmpC) };
  }

  /** Delete expired grants (all scopes when `space` is omitted). */
  async purgeExpiredGrants(space?: SpaceOf<P>): Promise<PurgeResult> {
    await this.ready();
    const scope = space === undefined ? null : this.scope(space);
    const now = this.clock();
    let purged = 0;
    for (const id of await this.store.listSubjects()) {
      purged += await this.mutate(id, (rec) => {
        if (!rec) return { result: 0 };
        const keep = rec.grants.filter((g) => this.live(g, now) || (scope !== null && g.spaceId !== scope.key));
        const n = rec.grants.length - keep.length;
        rec.grants = keep;
        return { next: n ? rec : null, result: n };
      });
    }
    return { purged };
  }

  /** Manual telemetry event (like `api_track_event`); reaches `onDecision` as `eventType: "custom"`. */
  async track(subject: string, permission: string, opts?: { allowed?: boolean; context?: Record<string, unknown>; space?: SpaceOf<P> }): Promise<TrackResult> {
    await this.ready();
    if (!subject || btrim(subject) === "") throw errorFromReason("subject_required");
    if (!permission || btrim(permission) === "") throw errorFromReason("permission_required");
    const ctx = toJson(opts?.context ?? {});
    const scope = this.scope(opts?.space);
    const rec = await this.store.getSubject(subject);
    const evaluated = this.evaluate(scope, rec, permission, isObj(ctx) ? ctx : {}, true);
    const allowed = opts?.allowed ?? evaluated.allowed;
    this.emit("custom", subject, permission, scope, allowed, allowed ? evaluated.matched : [], isObj(ctx) ? ctx : {});
    return { ok: true, id: uuid() };
  }

  // ── model reads ──────────────────────────────────────────────────────

  async listRoles(space?: SpaceOf<P>): Promise<Role[]> {
    await this.ready();
    const scope = this.scope(space);
    return [...scope.roles.values()]
      .map((r, i) => ({ r, i }))
      .sort((a, b) => cmpC(a.r.created_at, b.r.created_at) || a.i - b.i)
      .map(({ r }) => ({ slug: r.slug, name: r.name, description: r.description, space: scope.space?.slug ?? null, created_at: r.created_at }));
  }

  async listPermissions(space?: SpaceOf<P>): Promise<Permission[]> {
    await this.ready();
    const scope = this.scope(space);
    return [...scope.actions.values()]
      .map((a, i) => ({ a, i }))
      .sort((x, y) => cmpC(x.a.category, y.a.category) || x.i - y.i)
      .map(({ a }) => ({ slug: a.slug, name: a.name, description: a.description, category: a.category, space: scope.space?.slug ?? null, created_at: a.created_at }));
  }

  listActions(space?: SpaceOf<P>): Promise<Permission[]> {
    return this.listPermissions(space);
  }

  async listSpaces(): Promise<Space[]> {
    await this.ready();
    return [...this.model.spaces.values()]
      .map((s, i) => ({ s: s.space!, i }))
      .sort((a, b) => cmpC(a.s.created_at, b.s.created_at) || a.i - b.i)
      .map(({ s }) => ({ id: s.id, slug: s.slug, name: s.name, description: s.description, created_at: s.created_at }));
  }

  // ── runtime model changes (dynamic models) ───────────────────────────

  /** Create or update an action (upsert). Persisted in the store, layered over the policy. */
  async createPermission(input: CreatePermissionInput): Promise<CreatePermissionResult> {
    await this.ready();
    const scope = this.scope(input.space);
    const raw = input.slug;
    if (raw === null || raw === undefined || btrim(raw) === "") throw errorFromReason("invalid_slug:slug required");
    if (raw !== raw.toLowerCase() || !ACTION_SLUG_RE.test(raw)) throw errorFromReason(`invalid_slug:${raw}`);
    if (input.name === null || input.name === undefined || btrim(input.name) === "") throw errorFromReason("invalid_name:name required");
    const slug = btrim(raw);
    const spaceSlug = scope.space?.slug ?? null;
    const row = { space: spaceSlug, slug, name: btrim(input.name), category: nullIfBlank(input.category) ?? "General", description: nullIfBlank(input.description), created_at: scope.actions.get(slug)?.created_at ?? this.nowIso() };
    await this.saveModel((m) => {
      m.actions = m.actions.filter((a) => !(a.space === spaceSlug && a.slug === slug));
      m.actions.push(row);
    });
    return { slug, name: row.name, description: row.description, category: row.category, space: input.space ?? null, created_at: row.created_at };
  }

  createAction(input: CreatePermissionInput): Promise<CreatePermissionResult> {
    return this.createPermission(input);
  }

  /** Create or update a role; `permissions` must exist in the same scope and are added (never removed). */
  async createRole(input: CreateRoleInput): Promise<CreateRoleResult> {
    await this.ready();
    const scope = this.scope(input.space);
    if (input.slug === null || input.slug === undefined || btrim(input.slug) === "") throw errorFromReason("invalid_slug:slug required");
    const slug = btrim(input.slug).toLowerCase();
    if (!ROLE_SLUG_RE.test(slug)) throw errorFromReason(`invalid_slug:${input.slug}`);
    if (input.name === null || input.name === undefined || btrim(input.name) === "") throw errorFromReason("invalid_name:name required");
    const perms = input.permissions ?? [];
    for (const p of perms) {
      if (p === null || p === undefined || btrim(p) === "") throw errorFromReason("unknown_permission:empty");
      if (!scope.actions.has(btrim(p))) throw errorFromReason(`unknown_permission:${btrim(p)}`);
    }
    const spaceSlug = scope.space?.slug ?? null;
    const prev = this.overlay.roles.find((r) => r.space === spaceSlug && r.slug === slug);
    const row = {
      space: spaceSlug,
      slug,
      name: btrim(input.name),
      description: nullIfBlank(input.description),
      actions: [...new Set([...(prev?.actions ?? []), ...perms.map(btrim)])],
      created_at: scope.roles.get(slug)?.created_at ?? this.nowIso(),
    };
    await this.saveModel((m) => {
      m.roles = m.roles.filter((r) => !(r.space === spaceSlug && r.slug === slug));
      m.roles.push(row);
    });
    return { slug, name: row.name, description: row.description, space: input.space ?? null, created_at: row.created_at };
  }

  /** Create or update a space (isolated scope with its own actions, roles and grants). */
  async createSpace(input: CreateSpaceInput): Promise<Space> {
    await this.ready();
    if (input.slug === null || input.slug === undefined || btrim(input.slug) === "") throw errorFromReason("invalid_slug:slug required");
    const slug = btrim(input.slug).toLowerCase();
    if (!ROLE_SLUG_RE.test(slug)) throw errorFromReason(`invalid_slug:${input.slug}`);
    if (input.name === null || input.name === undefined || btrim(input.name) === "") throw errorFromReason("invalid_name:name required");
    const existing = this.model.spaces.get(slug)?.space;
    const row = { id: existing?.id ?? uuid(), slug, name: btrim(input.name), description: nullIfBlank(input.description), created_at: existing?.created_at ?? this.nowIso() };
    await this.saveModel((m) => {
      m.spaces = m.spaces.filter((s) => s.slug !== slug);
      m.spaces.push(row);
    });
    return { ...row };
  }

  /** Delete a runtime-created space with its roles, actions and grants. Policy-declared spaces can't be deleted at runtime. */
  async deleteSpace(space: SpaceOf<P>): Promise<void> {
    await this.ready();
    const scope = this.scope(space);
    if (!scope.space) throw errorFromReason("space_required");
    const { slug, id, inPolicy } = scope.space;
    if (inPolicy) throw errorFromReason(`space_in_policy:${slug} is declared in the policy — remove it there instead`);
    await this.saveModel((m) => {
      m.spaces = m.spaces.filter((s) => s.slug !== slug);
      m.actions = m.actions.filter((a) => a.space !== slug);
      m.roles = m.roles.filter((r) => r.space !== slug);
      m.defaults = m.defaults.filter((d) => d.space !== slug);
    });
    for (const sid of await this.store.listSubjects()) {
      await this.mutate(sid, (rec) => {
        if (!rec || !rec.grants.some((g) => g.spaceId === id)) return { result: undefined };
        rec.grants = rec.grants.filter((g) => g.spaceId !== id);
        return { next: rec, result: undefined };
      });
    }
  }

  /** Set (or clear with `null`) the role `provisionSubject` grants in a scope. Overrides the policy's `defaultRole`. */
  async setDefaultRole(input: { role: string | null; space?: SpaceOf<P> }): Promise<void> {
    await this.ready();
    const scope = this.scope(input.space);
    if (input.role !== null && !scope.roles.has(input.role)) throw errorFromReason(`unknown_role:${input.role}`);
    const spaceSlug = scope.space?.slug ?? null;
    await this.saveModel((m) => {
      m.defaults = m.defaults.filter((d) => d.space !== spaceSlug);
      m.defaults.push({ space: spaceSlug, role: input.role });
    });
  }

  // ── snapshots ────────────────────────────────────────────────────────

  /** Everything in the store as portable JSON (runtime model + subjects). */
  async exportState(): Promise<KeyringSnapshot> {
    await this.ready();
    const subjects: Record<string, StoredSubject> = {};
    for (const id of await this.store.listSubjects()) {
      const rec = await this.store.getSubject(id);
      if (rec) subjects[id] = toJson(rec);
    }
    return { format: "keyring.local", version: 1, exportedAt: this.nowIso(), model: toJson(this.overlay), subjects };
  }

  /** Load a snapshot. `replace` (default) drops subjects absent from it; `merge` keeps them. */
  async importState(snapshot: KeyringSnapshot, opts?: { mode?: "replace" | "merge" }): Promise<void> {
    await this.ready();
    if (!snapshot || snapshot.format !== "keyring.local" || snapshot.version !== 1) {
      throw errorFromReason("invalid_snapshot:want { format: \"keyring.local\", version: 1 }");
    }
    const mode = opts?.mode ?? "replace";
    if (mode === "replace") {
      for (const id of await this.store.listSubjects()) if (!(id in snapshot.subjects)) await this.store.deleteSubject(id);
    }
    for (const [id, rec] of Object.entries(snapshot.subjects)) await this.store.setSubject(id, toJson(rec));
    const model = mode === "replace" ? toJson(snapshot.model ?? emptyModel()) : mergeModels(this.overlay, snapshot.model ?? emptyModel());
    await this.saveModel((m) => Object.assign(m, model));
  }

  /** Re-read the runtime model from the store (pick up changes made by other processes). */
  async reload(): Promise<void> {
    this.applyModel(this.store.getModel());
    await this.ready();
  }
}

function mergeModels(a: RuntimeModel, b: RuntimeModel): RuntimeModel {
  const by = <T>(xs: T[], ys: T[], key: (x: T) => string) => {
    const m = new Map(xs.map((x) => [key(x), x]));
    for (const y of ys) m.set(key(y), y);
    return [...m.values()];
  };
  return toJson({
    spaces: by(a.spaces, b.spaces, (s) => s.slug),
    actions: by(a.actions, b.actions, (x) => `${x.space ?? ""}/${x.slug}`),
    roles: by(a.roles, b.roles, (x) => `${x.space ?? ""}/${x.slug}`),
    defaults: by(a.defaults, b.defaults, (x) => x.space ?? ""),
  });
}

/** Create a local (in-process) Keyring. Pass the policy as a literal or JSON import for typed slugs. */
export function createKeyring<const P extends KeyringPolicy = KeyringPolicy>(options: LocalKeyringOptions<P> = {}): LocalKeyring<P> {
  return new LocalKeyring<P>(options);
}
