import { hashApiKey } from "@/lib/api-keys";
import {
  badRequest,
  bearerHash,
  misconfigured,
  publicClient,
  requireScope,
  resolveApiKey,
  unauthorized,
} from "../../auth";

/*
 * POST /api/v1/subjects/provision { subject, display_name? }
 * Grant the workspace DEFAULT role to a subject (auto-provisioned,
 * idempotent). No role slug in the request — the server resolves
 * organizations.default_role_id, so a customer secret can never choose or
 * escalate to another role. Secret key, scope `grants.write`.
 * No default configured → 409 no_default_role (fail-closed).
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

  const body = (await req.json().catch(() => null)) as {
    subject?: unknown;
    display_name?: unknown;
  } | null;
  const subject = typeof body?.subject === "string" ? body.subject : "";
  if (!subject) return badRequest("Expected { subject: <external_id> }");
  const displayName = typeof body?.display_name === "string" ? body.display_name : null;

  const { data, error } = await supabase.rpc("api_provision_subject", {
    _hash: await hashApiKey(raw),
    _subject: subject,
    _display_name: displayName,
  });
  if (error) {
    if (error.message.includes("no_default_role")) {
      return Response.json(
        { error: "no_default_role: pick one in workspace Settings" },
        { status: 409 },
      );
    }
    return badRequest(error.message);
  }
  if (data === null) return unauthorized();
  return Response.json(data, { status: 201 });
}
