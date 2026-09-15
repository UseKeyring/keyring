import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { hashApiKey, type ApiKeyKind } from "@/lib/api-keys";

/*
 * Management API plumbing. There is deliberately NO service_role usage
 * anywhere in this stack: routes run over the publishable key and every
 * operation goes through a SECURITY DEFINER function that validates
 * the issued API key itself (bad/revoked key → NULL → 401 below).
 */

export type ApiKeyMeta = {
  name: string;
  organization_id: string;
  key_type: ApiKeyKind;
};

function buildPublicClient() {
  // Unified precedence (see middleware.ts): NEXT_PUBLIC_* first so the
  // management API hits the same project as the browser client.
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? process.env["SUPABASE_URL"] ?? "";
  const key =
    process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ??
    process.env["SUPABASE_PUBLISHABLE_KEY"] ??
    "";
  if (!url || !key) throw new Error("API not configured");
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Publishable-key client only — never service_role. Per-op auth happens
// inside the SECURITY DEFINER functions via the API-key hash.
export function publicClient() {
  try {
    return buildPublicClient();
  } catch {
    return null;
  }
}

export function bearerHash(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  // kr_sk_live_… / kr_pk_live_… / legacy kr_live_… ; `=` accepted for padded legacy keys.
  const match = /^Bearer ([A-Za-z0-9\-_=]+)$/.exec(header.trim());
  return match ? match[1]! : null;
}

export async function resolveApiKey(raw: string): Promise<ApiKeyMeta | null> {
  const supabase = publicClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("api_key_meta", {
    _hash: await hashApiKey(raw),
  });
  if (error || data == null) return null;
  const row = data as {
    name?: unknown;
    organization_id?: unknown;
    key_type?: unknown;
  };
  if (
    typeof row.name !== "string" ||
    typeof row.organization_id !== "string" ||
    (row.key_type !== "secret" && row.key_type !== "publishable")
  ) {
    return null;
  }
  return {
    name: row.name,
    organization_id: row.organization_id,
    key_type: row.key_type,
  };
}

export function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export function forbidden(message = "Forbidden") {
  return Response.json({ error: message }, { status: 403 });
}

export function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

export function notFound(message: string) {
  return Response.json({ error: message }, { status: 404 });
}

export function misconfigured() {
  return Response.json({ error: "API not configured" }, { status: 500 });
}

/** CORS headers for browser-safe check endpoint (Bearer + custom header, no cookies). */
export function checkCorsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-Keyring-Subject-Token",
    "Access-Control-Max-Age": "86400",
  };
}

export function withCors(res: Response, extra?: HeadersInit): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries({ ...checkCorsHeaders(), ...extra })) {
    headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
