// supabase/functions/_shared/polar.ts
// Centralized Polar API client. Pins all outbound requests to a date-based
// API version via the Polar-Version header so quarterly releases don't
// silently change our contract. Override per-environment without a code
// change: POLAR_API_VERSION=2026-10 (default stays on stable 2026-04).

export const POLAR_API_VERSION = "2026-04";

export const getPolarApiVersion = (): string => {
  const override = Deno.env.get("POLAR_API_VERSION")?.trim();
  return override || POLAR_API_VERSION;
};

export const resolvePolarBaseUrl = (): string => {
  const explicit = Deno.env.get("POLAR_API_URL");
  if (explicit) return explicit.replace(/\/+$/, "");
  const env = (Deno.env.get("POLAR_ENV") ?? "production").toLowerCase();
  return env === "sandbox"
    ? "https://sandbox-api.polar.sh/v1"
    : "https://api.polar.sh/v1";
};

const log = (step: string, data?: unknown) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, data }));
};

export const polarRequest = async <T>(
  accessToken: string,
  path: string,
  method: "POST" | "GET" | "PATCH",
  body?: Record<string, unknown>,
): Promise<T> => {
  const url = `${resolvePolarBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const version = getPolarApiVersion();

  log("polar_request:start", { method, url, version, body });

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Polar-Version": version,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const rawText = await res.text();
  log("polar_request:response", { method, path, status: res.status, ok: res.ok, body: rawText });

  if (!res.ok) {
    throw new Error(`Polar API ${method} ${path} failed (${res.status}): ${rawText}`);
  }

  try {
    return JSON.parse(rawText) as T;
  } catch {
    throw new Error(`Polar API returned invalid JSON for ${method} ${path}`);
  }
};
