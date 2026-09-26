import { z } from "zod";
import { hashApiKey } from "@/lib/api-keys";
import {
  badRequest,
  bearerHash,
  misconfigured,
  notFound,
  publicClient,
  requireScope,
  resolveApiKey,
  unauthorized,
} from "../auth";

/*
 * GET /api/v1/roles — customer-plane roles only. The hidden console plane
 * never leaks through this API. Requires roles.read scope.
 */
export async function GET(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "roles.read");
  if (scopeErr) return scopeErr;

  const { data, error } = await supabase.rpc("api_list_roles", {
    _hash: await hashApiKey(raw),
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (data === null) return unauthorized();

  return Response.json({ roles: data ?? [] });
}

const RoleBody = z.object({
  slug: z.string().min(1, "role slug required").max(120),
  name: z.string().min(1, "role name required").max(200),
  description: z.string().max(2000).optional(),
  // Action slugs to attach (must already exist — create them first via
  // POST /api/v1/permissions). Additive: re-POSTing never removes mappings.
  permissions: z.array(z.string().min(1)).max(500).optional(),
});

/*
 * POST /api/v1/roles { slug, name, description?, permissions? }
 * Create (or update) a customer-plane role in the key's workspace.
 * Idempotent — re-POSTing the same slug updates name/description and adds
 * any new permission links. Unknown permission slug → 404, no partial write.
 * Secret key with `roles.write` scope only.
 */
export async function POST(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "roles.write");
  if (scopeErr) return scopeErr;

  const parsed = RoleBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return badRequest("Expected { slug, name, description?: string, permissions?: string[] }");
  }
  const { slug, name, description, permissions } = parsed.data;

  const { data, error } = await supabase.rpc("api_create_role", {
    _hash: await hashApiKey(raw),
    _slug: slug.trim().toLowerCase(),
    _name: name.trim(),
    _description: description?.trim() || null,
    _permissions: permissions?.map((p) => p.trim()).filter(Boolean) ?? null,
  });
  if (error) {
    if (error.message.includes("unknown_permission")) {
      const detail = error.message.split("unknown_permission:")[1]?.trim() || "unknown";
      return notFound(`Unknown permission: ${detail}`);
    }
    if (error.message.includes("invalid_slug")) {
      const detail = error.message.split("invalid_slug:")[1]?.trim() || slug;
      return badRequest(`Invalid role slug: ${detail}`);
    }
    if (error.message.includes("invalid_name")) {
      return badRequest("Invalid role name: name is required");
    }
    return badRequest(error.message);
  }
  if (data === null) return unauthorized();

  return Response.json(data, { status: 201 });
}
