import { KeyringError } from "@usekeyring/sdk";

/** JSON whenever asked, or whenever stdout is not a terminal (agents, pipes, CI). */
export let jsonMode = !process.stdout.isTTY;

export function setJsonMode(value: boolean): void {
  jsonMode = value;
}

const tty = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: paint("2"),
  bold: paint("1"),
  green: paint("32"),
  red: paint("31"),
  yellow: paint("33"),
  blue: paint("34"),
};

/** Structured CLI failure: `code` is stable for agents, `hint` is the next move. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint?: string,
    readonly exitCode = 2,
    /** Extra machine-readable context merged into the JSON error (e.g. a refused plan). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Print a result: JSON in json mode, `human()` (or pretty JSON) otherwise. */
export function emit(data: unknown, human?: () => string | void): void {
  if (jsonMode || !human) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  const text = human();
  if (typeof text === "string" && text.length > 0) process.stdout.write(`${text}\n`);
}

/** Log progress to stderr so stdout stays machine-parsable. */
export function info(message: string): void {
  if (!jsonMode) process.stderr.write(`${message}\n`);
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof KeyringError) {
    const code = err.body.code ?? (err.status === 401 ? "unauthorized" : `http_${err.status}`);
    const hint =
      err.status === 401
        ? "Run `keyring whoami` to inspect the key, or `keyring keys create` to mint one with the needed scope."
        : code === "unknown_role"
          ? "List roles with `keyring roles`, or declare it in keyring.policy.json and run `keyring push`."
          : code === "unknown_permission"
            ? "Create the action first (`keyring push` or `keyring actions` to list). Actions are resource.verb."
            : code === "no_default_role"
              ? 'Set "defaultRole" in keyring.policy.json and run `keyring push`.'
              : undefined;
    return new CliError(err.message, code, hint);
  }
  const e = err as { code?: string; message?: string };
  if (e?.code === "ECONNREFUSED") {
    return new CliError(e.message ?? "connection refused", "connection_refused", "Is the database / server running? `keyring doctor` checks every link.");
  }
  if (e?.code === "3D000" || e?.code === "42P01" || e?.code === "42883" || e?.code === "3F000") {
    return new CliError(e.message ?? "schema missing", "schema_missing", "Install the schema with `keyring migrate`.");
  }
  return new CliError(err instanceof Error ? err.message : String(err), "error");
}

export function fail(err: unknown): never {
  const e = toCliError(err);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: e.code, message: e.message, hint: e.hint }, ...e.details }, null, 2)}\n`);
  } else {
    process.stderr.write(`${c.red("error")} ${e.message} ${c.dim(`(${e.code})`)}\n`);
    if (e.hint) process.stderr.write(`${c.dim("hint")}  ${e.hint}\n`);
  }
  process.exit(e.exitCode);
}

export function table(rows: Record<string, unknown>[], columns: string[]): string {
  if (rows.length === 0) return c.dim("(none)");
  const cell = (v: unknown) =>
    v == null ? "" : v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
  const widths = columns.map((col) => Math.min(48, Math.max(col.length, ...rows.map((r) => cell(r[col]).length))));
  const line = (vals: string[]) => vals.map((v, i) => v.slice(0, 48).padEnd(widths[i] ?? 0)).join("  ");
  return [c.dim(line(columns)), ...rows.map((r) => line(columns.map((col) => cell(r[col]))))].join("\n");
}
