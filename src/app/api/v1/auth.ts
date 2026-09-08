import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

/*
 * Management API plumbing. There is deliberately NO service_role usage
 * anywhere in this stack: routes run over the publishable key and every
 * operation goes through a SECURITY DEFINER function in 0007 that validates
 * the issued API key itself (bad/revoked key → NULL → 401 below).
 */

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
  // kr_live_<base64url-unpadded> today; `=` accepted so padded legacy keys don't 401.
  const match = /^Bearer ([A-Za-z0-9\-_=]+)$/.exec(header.trim());
  return match ? match[1]! : null;
}

export function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
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
