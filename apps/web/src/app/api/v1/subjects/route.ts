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

const SubjectBody = z.object({
  subject: z.string().min(1, "subject external_id required"),
  attrs: z.record(z.string(), z.unknown()),
  display_name: z.string().optional(),
});

/*
 * POST /api/v1/subjects { subject, attrs, display_name? }
 * Upsert subject attributes (merged server-side). Secret key
 * (grants.write) only. Attrs feed ABAC grant conditions at check time.
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

  const parsed = SubjectBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return badRequest("Expected { subject: external_id, attrs: object, display_name?: string }");
  }

  const { data, error } = await supabase.rpc("api_set_subject_attrs", {
    _hash: await hashApiKey(raw),
    _subject: parsed.data.subject,
    _attrs: parsed.data.attrs as never,
    _display_name: parsed.data.display_name ?? null,
  });
  if (error) return badRequest(error.message);
  if (data === null) return unauthorized();

  return Response.json(
    { ok: true, subject: parsed.data.subject, attrs: parsed.data.attrs },
    { status: 200 },
  );
}
