import { errorFromResponse, type KeyringErrorBody } from "./errors.js";

export const SUBJECT_TOKEN_HEADER = "X-Keyring-Subject-Token";

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export async function apiRequest<T>(input: {
  baseUrl: string;
  apiKey: string;
  path: string;
  method?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  subjectToken?: string | null;
  fetchImpl: typeof fetch;
  headers?: Record<string, string>;
}): Promise<T> {
  const url = new URL(`${normalizeBaseUrl(input.baseUrl)}${input.path}`);
  if (input.query) {
    for (const [key, value] of Object.entries(input.query)) {
      if (value != null && value !== "") url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.apiKey}`,
    Accept: "application/json",
    ...input.headers,
  };
  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (input.subjectToken) {
    headers[SUBJECT_TOKEN_HEADER] = input.subjectToken;
  }

  const res = await input.fetchImpl(url, {
    method: input.method ?? "GET",
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { error: text };
    }
  }

  if (!res.ok) {
    const body = (parsed && typeof parsed === "object" ? parsed : {}) as KeyringErrorBody;
    throw errorFromResponse(res.status, body);
  }

  return parsed as T;
}
