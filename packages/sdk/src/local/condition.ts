/**
 * ABAC condition engine — a faithful port of `drizzle/native.sql` §3
 * (`_abac_lookup`, `_abac_clause_matches`, `_abac_condition_matches`).
 *
 * Grammar (one clause per object, first key that matches wins, in this order):
 *   { all: [c, …] }   every sub-condition holds          ({ all: [] } → true)
 *   { any: [c, …] }   at least one holds                  ({ any: [] } → false)
 *   { not: c }        negation
 *   { attr, from?, exists | equals | in | gt | gte | lt | lte }
 *     from: "either" (default — request context wins over stored attrs),
 *           "subject" (stored attrs only), "context" (request context only)
 *
 * Postgres semantics kept on purpose (parity tests pin them):
 *   - `{}` and a missing condition always match.
 *   - Missing attr → false for every operator except `exists: false`.
 *     A key present with JSON `null` counts as present.
 *   - equals / in use jsonb equality (deep, type-strict: "1" ≠ 1, 1 = 1.0).
 *   - gt/gte/lt/lte cast the attr like `::double precision` ("42" works,
 *     non-numeric → false), and the bound must be a JSON number.
 *   - Comparing a JSON `null` attr yields SQL NULL ("unknown"): it fails at
 *     the top level and under `any`, is skipped by `all`, stays unknown under
 *     `not`. Represented here as `null`.
 */
import { errorFromReason, KeyringError } from "../errors.js";
import type { AbacCondition } from "../types.js";

/** Three-valued result: `null` = SQL NULL (unknown → not granted). */
export type Tri = boolean | null;
export type AttrSource = "context" | "subject" | "missing";

export type ConditionTrace = {
  attr: string;
  op: "exists" | "equals" | "in" | "gt" | "gte" | "lt" | "lte";
  expected: unknown;
  actual: unknown;
  source: AttrSource;
  result: Tri;
};

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = Record<string, unknown>;

const OPS = ["gt", "gte", "lt", "lte"] as const;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** jsonb `?` operator: object key, array string element, or equal string scalar. */
function has(v: unknown, key: string): boolean {
  if (isObj(v)) return own(v, key);
  if (Array.isArray(v)) return v.some((x) => x === key);
  return typeof v === "string" && v === key;
}

/** jsonb `->` with a text key: only objects yield a value; `undefined` = SQL NULL. */
function get(v: unknown, key: string): unknown {
  return isObj(v) && own(v, key) ? v[key] : undefined;
}

/** jsonb `->>` / `#>> '{}'`: text of a value; JSON null → SQL NULL. */
function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return jsonbText(v);
}

/** Render like Postgres jsonb output (keys sorted by length, then bytes). */
export function jsonbText(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(", ")}]`;
  const keys = Object.keys(v as Obj).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${jsonbText((v as Obj)[k])}`).join(", ")}}`;
}

/** jsonb `=`: deep, type-strict equality. */
export function jsonbEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonbEquals(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((k) => own(b, k) && jsonbEquals(a[k], b[k]));
  }
  return false;
}

const SPACE = /^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g;
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** `text::double precision` — `undefined` when Postgres would raise. */
function pgFloat(s: string): number | undefined {
  const t = s.replace(SPACE, "");
  const lower = t.toLowerCase();
  if (lower === "nan") return NaN;
  if (/^[+]?(inf|infinity)$/.test(lower)) return Infinity;
  if (/^-(inf|infinity)$/.test(lower)) return -Infinity;
  if (!FLOAT_RE.test(t)) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n)) return undefined; // overflow → "out of range"
  if (n === 0 && /[1-9]/.test(t.split(/[eE]/)[0]!)) return undefined; // underflow
  return n;
}

/** float8 ordering: NaN equals NaN and sorts above every other value. */
function cmp(a: number, b: number): number {
  if (Number.isNaN(a)) return Number.isNaN(b) ? 0 : 1;
  if (Number.isNaN(b)) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `text::boolean` (Postgres boolin, prefixes allowed). Throws 22P02 like Postgres. */
function pgBool(s: string): boolean {
  const t = s.replace(SPACE, "");
  const l = t.toLowerCase();
  const n = l.length;
  const pre = (word: string, min = 1) => n >= min && word.startsWith(l);
  if (n > 0) {
    switch (l[0]) {
      case "t":
        if (pre("true")) return true;
        break;
      case "f":
        if (pre("false")) return false;
        break;
      case "y":
        if (pre("yes")) return true;
        break;
      case "n":
        if (pre("no")) return false;
        break;
      case "o":
        if (l === "on") return true;
        if (pre("off", 2)) return false;
        break;
      case "1":
        if (n === 1) return true;
        break;
      case "0":
        if (n === 1) return false;
        break;
    }
  }
  const message = `invalid input syntax for type boolean: "${s}"`;
  throw new KeyringError(message, 500, { error: message, code: "22P02" });
}

function elements(v: unknown): unknown[] {
  const list = v === undefined ? [] : v; // COALESCE(_clause -> 'all', '[]')
  if (Array.isArray(list)) return list;
  const message = `cannot extract elements from ${isObj(list) ? "an object" : "a scalar"}`;
  throw new KeyringError(message, 500, { error: message, code: "22023" });
}

const btrimSpaces = (s: string) => s.replace(/^ +| +$/g, "");

/**
 * `_abac_condition_matches(condition, subject_attrs, context)`.
 * `condition === undefined` is SQL NULL (matches); `null` is JSON null.
 */
export function conditionMatches(
  condition: unknown,
  attrs: Obj | undefined,
  context: Obj | undefined,
  trace?: ConditionTrace[],
): Tri {
  if (condition === undefined || (isObj(condition) && Object.keys(condition).length === 0)) return true;
  return clauseMatches(condition, attrs ?? {}, context ?? {}, trace);
}

function clauseMatches(c: unknown, attrs: Obj, ctx: Obj, trace?: ConditionTrace[]): Tri {
  if (has(c, "all")) {
    for (const item of elements(get(c, "all"))) {
      if (conditionMatches(item, attrs, ctx, trace) === false) return false;
    }
    return true;
  }
  if (has(c, "any")) {
    for (const item of elements(get(c, "any"))) {
      if (conditionMatches(item, attrs, ctx, trace) === true) return true;
    }
    return false;
  }
  if (has(c, "not")) {
    const r = conditionMatches(get(c, "not"), attrs, ctx, trace);
    return r === null ? null : !r;
  }
  const attr = text(get(c, "attr"));
  if (attr === undefined || btrimSpaces(attr) === "") return false;
  const fromRaw = text(get(c, "from"));
  const from = fromRaw === undefined || fromRaw === "" ? "either" : fromRaw;
  if (from !== "either" && from !== "subject" && from !== "context") {
    throw errorFromReason(`invalid_condition_from:${from}`);
  }
  let actual: unknown;
  let source: AttrSource = "missing";
  if (from !== "subject" && own(ctx, attr) && ctx[attr] !== undefined) {
    actual = ctx[attr];
    source = "context";
  } else if (from !== "context" && own(attrs, attr) && attrs[attr] !== undefined) {
    actual = attrs[attr];
    source = "subject";
  }
  const note = (op: ConditionTrace["op"], expected: unknown, result: Tri): Tri => {
    trace?.push({ attr, op, expected, actual, source, result });
    return result;
  };

  if (has(c, "exists")) {
    const raw = text(get(c, "exists"));
    const want = raw === undefined ? false : pgBool(raw);
    return note("exists", get(c, "exists"), want ? source !== "missing" : source === "missing");
  }
  const firstOp = (["equals", "in", ...OPS] as const).find((op) => has(c, op));
  if (source === "missing") {
    if (firstOp) return note(firstOp, get(c, firstOp), false);
    return false;
  }
  if (has(c, "equals")) return note("equals", get(c, "equals"), jsonbEquals(actual, get(c, "equals")));
  if (has(c, "in")) {
    const list = get(c, "in");
    if (!Array.isArray(list)) throw errorFromReason("invalid_condition_in (want array)");
    return note("in", list, list.some((item) => jsonbEquals(actual, item)));
  }
  for (const op of OPS) {
    if (!has(c, op)) continue;
    const raw = text(actual);
    const num = raw === undefined ? null : pgFloat(raw);
    if (num === undefined) return note(op, get(c, op), false);
    const expected = get(c, op);
    if (typeof expected !== "number") throw errorFromReason(`invalid_condition_${op} (want number)`);
    if (num === null) return note(op, expected, null);
    const d = cmp(num, expected);
    return note(op, expected, op === "gt" ? d > 0 : op === "gte" ? d >= 0 : op === "lt" ? d < 0 : d <= 0);
  }
  throw errorFromReason(`invalid_condition:${jsonbText(c)} (want all|any|not|equals|in|gt|gte|lt|lte|exists)`);
}

/** Grant-time validation, exactly like `api_grant_role` (evaluates against empty attrs). */
export function validateCondition(condition: unknown): AbacCondition {
  const cond = condition === undefined || condition === null ? {} : condition;
  if (!isObj(cond)) throw errorFromReason("invalid_condition (want object)");
  conditionMatches(cond, {}, {});
  return cond as AbacCondition;
}

/** JSON round-trip (what the Postgres/hosted paths do over the wire). */
export function toJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export type { Json };
