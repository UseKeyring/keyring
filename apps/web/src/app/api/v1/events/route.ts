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

const TrackBody = z.object({
  subject: z.string().min(1, "subject external_id required"),
  permission: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  allowed: z.boolean().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

/*
 * POST /api/v1/events { subject, permission|action, allowed?, context? }
 * Manual telemetry event (paired with auto-logged GET /api/v1/check rows).
 * Secret key with `telemetry.write` scope only — publishable keys stay
 * check-only. Resolves `allowed` via the RBAC graph when omitted.
 */
export async function POST(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "telemetry.write");
  if (scopeErr) return scopeErr;

  const parsed = TrackBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return badRequest("Expected { subject, permission|action, allowed?, context? }");
  }
  const perm = (parsed.data.permission ?? parsed.data.action ?? "").trim();
  if (!perm) return badRequest("Expected { subject, permission|action, allowed?, context? }");

  const { data, error } = await supabase.rpc("api_track_event", {
    _hash: await hashApiKey(raw),
    _subject: parsed.data.subject.trim(),
    _perm: perm,
    _allowed: parsed.data.allowed ?? null,
    _context: (parsed.data.context ?? {}) as never,
  });
  if (error) {
    if (error.message.includes("telemetry_disabled")) {
      return badRequest("Telemetry is disabled for this workspace");
    }
    return badRequest(error.message);
  }
  if (data === null) return unauthorized();

  return Response.json({ ok: true, id: data }, { status: 201 });
}
