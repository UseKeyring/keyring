import { z } from "zod";
import { mintSubjectToken } from "@/lib/subject-tokens";
import {
  badRequest,
  bearerHash,
  forbidden,
  misconfigured,
  resolveApiKey,
  unauthorized,
} from "../auth";

const Body = z.object({
  subject: z.string().min(1, "subject required"),
  ttl_seconds: z.number().int().optional(),
});

/*
 * POST /api/v1/subject-tokens { subject, ttl_seconds? }
 * Secret key only. Mints a short-lived JWT the browser pairs with a
 * publishable key for GET /api/v1/check.
 */
export async function POST(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  if (!process.env["SUBJECT_TOKEN_SECRET"] && !process.env["KEYRING_SUBJECT_TOKEN_SECRET"]) {
    return misconfigured();
  }

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  if (meta.key_type !== "secret") {
    return forbidden("Publishable keys cannot mint subject tokens");
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return badRequest("Expected { subject: string, ttl_seconds?: number }");
  }

  try {
    const minted = await mintSubjectToken({
      subject: parsed.data.subject,
      organizationId: meta.organization_id,
      ...(parsed.data.ttl_seconds != null
        ? { ttlSeconds: parsed.data.ttl_seconds }
        : {}),
    });
    return Response.json({
      token: minted.token,
      subject: minted.subject,
      expires_at: minted.expiresAt.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not mint token";
    if (message.includes("SUBJECT_TOKEN_SECRET")) return misconfigured();
    return badRequest(message);
  }
}
