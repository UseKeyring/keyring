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

const ConditionSchema: z.ZodType<Record<string, unknown>> = z.record(
  z.string(),
  z.unknown(),
);

const GrantBody = z.object({
  role: z.string().min(1, "role slug required"),
  subject: z.string().min(1, "subject external_id required"),
  display_name: z.string().optional(),
  // Temporary access: either an absolute expiry or a TTL in seconds
  // (e.g. ttl_seconds: 300 = "can create repos for the next 5 minutes").
  // ttl_seconds wins when both are given. NULL/omitted = permanent.
  expires_at: z.string().datetime().optional(),
  ttl_seconds: z.number().int().min(30).max(31536000).optional(),
  // ABAC gate on the grant, e.g. { attr: "plan", in: ["pro","enterprise"] }.
  // {} / omitted = unconditional (previous behaviour).
  condition: ConditionSchema.optional(),
});

/*
 * POST /api/v1/grants { role, subject, display_name?, expires_at?, ttl_seconds? }
 * Grant a customer role to a subject (auto-provisions the subject,
 * fail-closed: holding nothing until granted). Idempotent — re-granting the
 * same pair upserts the expiry so temporary access can be extended without
 * a revoke first. Secret key (grants.write) only.
 */
export async function POST(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "grants.write");
  if (scopeErr) return scopeErr;

  const parsed = GrantBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Expected { role: slug, subject: external_id, display_name?: string, expires_at?: ISO datetime, ttl_seconds?: number }");
  const { role: roleSlug, subject: externalId, display_name, expires_at, ttl_seconds, condition } = parsed.data;

  const { data, error } = await supabase.rpc("api_grant_role", {
    _hash: await hashApiKey(raw),
    _role: roleSlug,
    _subject: externalId,
    _display_name: display_name ?? null,
    _expires_at: expires_at ?? null,
    _ttl_seconds: ttl_seconds ?? null,
    _condition: (condition ?? null) as never,
  });
  if (error) {
    if (error.message.includes("unknown_role")) return notFound(`Unknown role: ${roleSlug}`);
    return badRequest(error.message);
  }
  if (data === null) return unauthorized();

  return Response.json(
    { ok: true, role: roleSlug, subject: externalId, expires_at: expires_at ?? null, ttl_seconds: ttl_seconds ?? null, condition: condition ?? null },
    { status: 201 },
  );
}

/*
 * DELETE /api/v1/grants { role, subject }
 * Revoke a customer role from a subject. Idempotent. Secret key only.
 */
export async function DELETE(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "grants.write");
  if (scopeErr) return scopeErr;

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
