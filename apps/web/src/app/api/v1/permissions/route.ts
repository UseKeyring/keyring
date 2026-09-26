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
 * GET /api/v1/permissions — customer-plane actions only. The hidden console
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

  const { data, error } = await supabase.rpc("api_list_permissions", {
    _hash: await hashApiKey(raw),
  });
  if (error) {
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
});

/*
 * POST /api/v1/permissions { slug, name, category?, description? }
 * Create (or update) a customer-plane action in the key's workspace.
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
    return badRequest("Expected { slug, name, category?: string, description?: string }");
  }
  const { slug, name, category, description } = parsed.data;

  const { data, error } = await supabase.rpc("api_create_permission", {
    _hash: await hashApiKey(raw),
    _slug: slug.trim().toLowerCase(),
    _name: name.trim(),
    _category: category?.trim() || null,
    _description: description?.trim() || null,
  });
  if (error) {
    // invalid_slug / invalid_name from the RPC already carry a readable reason.
    return badRequest(error.message);
  }
  if (data === null) return unauthorized();

  return Response.json(data, { status: 201 });
}
