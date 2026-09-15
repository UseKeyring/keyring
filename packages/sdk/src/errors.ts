export type KeyringErrorBody = {
  error?: string;
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
