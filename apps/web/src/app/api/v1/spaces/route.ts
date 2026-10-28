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

const CreateBody = z.object({
  slug: z.string().min(1, "space slug required").max(120),
  name: z.string().min(1, "space name required").max(200),
  description: z.string().max(2000).optional(),
});

const DeleteBody = z.object({
  space: z.string().min(1, "space slug required").max(120),
});

/*
 * GET /api/v1/spaces — list spaces (secret, spaces.read).
 * POST /api/v1/spaces { slug, name, description? } — create (secret,
 *   spaces.write). Idempotent: re-POSTing the same slug updates name/
 *   description. Slugs are kebab-case, unique per workspace.
 * DELETE /api/v1/spaces { space } — delete (secret, spaces.write).
 *   Cascades to the space's roles, actions, links and grants.
 *
 * Spaces are the second isolation layer: roles, actions and grants live in
 * exactly one scope (platform = no space, or one space slug). Checks
 * evaluate exactly the scope passed — no cross-scope inheritance.
 */
export async function GET(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "spaces.read");
  if (scopeErr) return scopeErr;

  const { data, error } = await supabase.rpc("api_list_spaces", {
    _hash: await hashApiKey(raw),
  });
  if (error) return badRequest(error.message);
  if (data === null) return unauthorized();
  return Response.json({ spaces: data });
}

export async function POST(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "spaces.write");
  if (scopeErr) return scopeErr;

  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return badRequest("Expected { slug, name, description?: string }");
  }

  const { data, error } = await supabase.rpc("api_create_space", {
    _hash: await hashApiKey(raw),
    _slug: parsed.data.slug.trim().toLowerCase(),
    _name: parsed.data.name.trim(),
    _description: parsed.data.description?.trim() || null,
  });
  if (error) {
    if (error.message.includes("invalid_slug")) {
      return badRequest(`Invalid space slug: ${parsed.data.slug}`);
    }
    if (error.message.includes("invalid_name")) {
      return badRequest("Invalid space name: name is required");
    }
    return badRequest(error.message);
  }
  if (data === null) return unauthorized();
  return Response.json(data, { status: 201 });
}

export async function DELETE(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "spaces.write");
  if (scopeErr) return scopeErr;

  const parsed = DeleteBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Expected { space: slug }");

  const { data, error } = await supabase.rpc("api_delete_space", {
    _hash: await hashApiKey(raw),
    _space: parsed.data.space.trim(),
  });
  if (error) {
    if (error.message.includes("unknown_space")) {
      return notFound(`Unknown space: ${parsed.data.space}`);
    }
    return badRequest(error.message);
  }
  if (data === null) return unauthorized();
  return Response.json({ ok: true, deleted: true });
}
