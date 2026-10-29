export type KeyringErrorBody = {
  error?: string;
  /** Machine-readable reason, e.g. `unknown_role` (embedded mode + CLI). */
  code?: string;
};

export class KeyringError extends Error {
  readonly status: number;
  readonly body: KeyringErrorBody;

  constructor(message: string, status: number, body: KeyringErrorBody = {}) {
    super(message);
    this.name = "KeyringError";
    this.status = status;
    this.body = body;
  }
}

export class UnauthorizedError extends KeyringError {
  constructor(message = "Unauthorized", body: KeyringErrorBody = {}) {
    super(message, 401, body);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends KeyringError {
  constructor(message = "Forbidden", body: KeyringErrorBody = {}) {
    super(message, 403, body);
    this.name = "ForbiddenError";
  }
}

export class BadRequestError extends KeyringError {
  constructor(message = "Bad request", body: KeyringErrorBody = {}) {
    super(message, 400, body);
    this.name = "BadRequestError";
  }
}

export class NotFoundError extends KeyringError {
  constructor(message = "Not found", body: KeyringErrorBody = {}) {
    super(message, 404, body);
    this.name = "NotFoundError";
  }
}

export class ApiError extends KeyringError {
  constructor(message: string, status: number, body: KeyringErrorBody = {}) {
    super(message, status, body);
    this.name = "ApiError";
  }
}

export function errorFromResponse(status: number, body: KeyringErrorBody): KeyringError {
  const message = body.error?.trim() || `Request failed with status ${status}`;
  if (status === 401) return new UnauthorizedError(message, body);
  if (status === 403) return new ForbiddenError(message, body);
  if (status === 400) return new BadRequestError(message, body);
  if (status === 404) return new NotFoundError(message, body);
  return new ApiError(message, status, body);
}

/**
 * Map a Keyring `RAISE EXCEPTION 'reason:detail'` message to a typed error.
 * Shared by embedded (Postgres) and local mode so both throw identical errors:
 * `unknown_*` → NotFoundError, `*_forbidden` → ForbiddenError, else BadRequestError.
 */
export function errorFromReason(message: string): KeyringError {
  const [reason = "error", ...rest] = message.split(":");
  const detail = rest.join(":").trim();
  // unknown_role:viewer → "Unknown role: viewer" (code stays machine-readable)
  const words = reason.replace(/_/g, " ");
  const human = `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}${detail ? `: ${detail}` : ""}`;
  const body = { error: human, code: reason };
  if (reason.startsWith("unknown_")) return new NotFoundError(human, body);
  if (reason.endsWith("_forbidden")) return new ForbiddenError(human, body);
  return new BadRequestError(human, body);
}
