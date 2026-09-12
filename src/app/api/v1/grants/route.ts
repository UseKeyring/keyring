import { z } from "zod";
import { hashApiKey } from "@/lib/api-keys";
import {
  badRequest,
  bearerHash,
  misconfigured,
  notFound,
  publicClient,
  unauthorized,
} from "../auth";

const GrantBody = z.object({
  role: z.string().min(1, "role slug required"),
  subject: z.string().min(1, "subject external_id required"),
  display_name: z.string().optional(),
});

/*
 * POST /api/v1/grants { role, subject, display_name? }
 * Grant a customer role to a subject (auto-provisions the subject,
 * fail-closed: holding nothing until granted). Idempotent.
 */
export async function POST(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const parsed = GrantBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Expected { role: slug, subject: external_id, display_name?: string }");
  const { role: roleSlug, subject: externalId, display_name } = parsed.data;

  const { data, error } = await supabase.rpc("api_grant_role", {
    _hash: await hashApiKey(raw),
    _role: roleSlug,
    _subject: externalId,
    _display_name: display_name ?? null,
  });
  if (error) {
    if (error.message.includes("unknown_role")) return notFound(`Unknown role: ${roleSlug}`);
    return badRequest(error.message);
  }
  if (data === null) return unauthorized();

  return Response.json({ ok: true, role: roleSlug, subject: externalId }, { status: 201 });
}

/*
 * DELETE /api/v1/grants { role, subject }
 * Revoke a customer role from a subject. Idempotent.
 */
export async function DELETE(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const parsed = GrantBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Expected { role: slug, subject: external_id }");
  const { role: roleSlug, subject: externalId } = parsed.data;

  const { data, error } = await supabase.rpc("api_revoke_grant", {
    _hash: await hashApiKey(raw),
    _role: roleSlug,
    _subject: externalId,
  });
  if (error) {
    if (error.message.includes("unknown_role")) return notFound(`Unknown role: ${roleSlug}`);
    return badRequest(error.message);
  }
  if (data === null) return unauthorized();

  return Response.json({ ok: true, revoked: true });
}
