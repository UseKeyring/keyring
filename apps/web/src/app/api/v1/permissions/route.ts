import { z } from "zod";
import { hashApiKey } from "@/lib/api-keys";
import {
  badRequest,
  bearerHash,
  misconfigured,
  publicClient,
  requireScope,
  resolveApiKey,
  unauthorized,
} from "../auth";

/*
 * GET /api/v1/permissions?space=<slug?> — customer-plane actions of one scope
 * (omitted = platform scope). The hidden console
 * plane never leaks through this API. Requires actions.read scope.
 */
export async function GET(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "actions.read");
  if (scopeErr) return scopeErr;

  const space = new URL(req.url).searchParams.get("space")?.trim() || null;

  const { data, error } = await supabase.rpc("api_list_permissions", {
    _hash: await hashApiKey(raw),
    _space: space,
  });
  if (error) {
    if (error.message.includes("unknown_space")) {
      return Response.json({ error: `Unknown space: ${space}` }, { status: 404 });
    }
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (data === null) return unauthorized();

  return Response.json({ permissions: data ?? [] });
}

const PermissionBody = z.object({
  slug: z.string().min(1, "action slug required").max(120),
  name: z.string().min(1, "action name required").max(200),
  category: z.string().max(60).optional(),
  description: z.string().max(2000).optional(),
  // Scope: space slug or omitted for the platform scope.
  space: z.string().min(1).max(120).optional(),
});

/*
 * POST /api/v1/permissions { slug, name, category?, description?, space? }
 * Create (or update) a customer-plane action in the key's workspace + scope.
 * Idempotent — re-POSTing the same slug updates name/category/description.
 * Secret key with `actions.write` scope only.
 */
export async function POST(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "actions.write");
  if (scopeErr) return scopeErr;

  const parsed = PermissionBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return badRequest("Expected { slug, name, category?: string, description?: string, space?: string }");
  }
  const { slug, name, category, description, space } = parsed.data;

  const { data, error } = await supabase.rpc("api_create_permission", {
    _hash: await hashApiKey(raw),
    _slug: slug.trim().toLowerCase(),
    _name: name.trim(),
    _category: category?.trim() || null,
    _description: description?.trim() || null,
    _space: space?.trim() || null,
  });
  if (error) {
    if (error.message.includes("unknown_space")) {
      return Response.json({ error: `Unknown space: ${space}` }, { status: 404 });
    }
    // invalid_slug / invalid_name from the RPC already carry a readable reason.
    return badRequest(error.message);
  }
  if (data === null) return unauthorized();

  return Response.json(data, { status: 201 });
}
