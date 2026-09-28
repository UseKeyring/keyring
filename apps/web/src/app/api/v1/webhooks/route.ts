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

const CreateBody = z.object({
  name: z.string().min(1, "name required"),
  url: z.string().url("url must be a valid https URL").startsWith("https://", "url must be https://…"),
  // Omitted = server mints kr_ws_live_… at creation and returns it once.
  // Supplied = bring-your-own secret (min 16 chars).
  secret: z.string().min(16, "secret must be at least 16 chars").optional(),
  events: z.array(z.string().min(1)).optional(),
});

const DeleteBody = z.object({
  id: z.string().uuid("id must be a UUID"),
});

/*
 * GET /api/v1/webhooks — list outbound endpoints (secret, webhooks.read).
 * POST /api/v1/webhooks { name, url, secret?, events? } — create (secret,
 *   webhooks.write). Omit secret to have the server mint kr_ws_live_… at
 *   creation; the raw value is returned ONCE in the 201 response.
 * DELETE /api/v1/webhooks { id } — delete (secret, webhooks.write).
 *
 * Events catalog: grant.created/updated/deleted, subject.created/updated/deleted,
 * role.created/updated/deleted, permission.created/updated/deleted,
 * role.permissions_updated. Subscriptions accept exact names, prefixes
 * (grant.*), or full wildcard (*); empty array = all events.
 */
export async function GET(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "webhooks.read");
  if (scopeErr) return scopeErr;

  const { data, error } = await supabase.rpc("api_list_webhook_endpoints", {
    _hash: await hashApiKey(raw),
  });
  if (error) return badRequest(error.message);
  if (data === null) return unauthorized();
  return Response.json({ endpoints: data });
}

export async function POST(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "webhooks.write");
  if (scopeErr) return scopeErr;

  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return badRequest("Expected { name, url: https://…, secret?: min 16 chars (omit to auto-generate), events?: string[] }");
  }

  const { data, error } = await supabase.rpc("api_create_webhook_endpoint", {
    _hash: await hashApiKey(raw),
    _name: parsed.data.name,
    _url: parsed.data.url,
    _secret: parsed.data.secret ?? null,
    _events: parsed.data.events ?? [],
  });
  if (error) return badRequest(error.message);
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
  const scopeErr = requireScope(meta, "webhooks.write");
  if (scopeErr) return scopeErr;

  const parsed = DeleteBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Expected { id: uuid }");

  const { data, error } = await supabase.rpc("api_delete_webhook_endpoint", {
    _hash: await hashApiKey(raw),
    _id: parsed.data.id,
  });
  if (error) return badRequest(error.message);
  if (data === null) return unauthorized();
  return Response.json({ ok: true, deleted: true });
}
