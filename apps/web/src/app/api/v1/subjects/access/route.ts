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
 * GET /api/v1/subjects/access?subject=<external_id>
 * Full access snapshot for one subject — backfill + nightly reconcile for
 * customer mirrors (keyring.access). Secret key, scope `check`.
 * Expired grants are excluded (mirror helpers filter them too; rows stay).
 * Unknown subject → empty roles/permissions (not 404) so appliers can
 * reconcile deletions idempotently.
 */
export async function GET(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "check");
  if (scopeErr) return scopeErr;

  const subject = new URL(req.url).searchParams.get("subject") ?? "";
  if (!subject) return badRequest("Expected ?subject=<external_id>");

  const { data, error } = await supabase.rpc("api_get_subject_access", {
    _hash: await hashApiKey(raw),
    _subject: subject,
  });
  if (error) return badRequest(error.message);
  if (data === null) return unauthorized();
  return Response.json(data);
}
