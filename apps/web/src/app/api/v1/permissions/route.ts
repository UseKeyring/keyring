import { hashApiKey } from "@/lib/api-keys";
import {
  bearerHash,
  misconfigured,
  publicClient,
  requireScope,
  resolveApiKey,
  unauthorized,
} from "../auth";

/*
 * GET /api/v1/permissions — customer-plane actions only. The hidden console
 * plane never leaks through this API. Requires actions.read scope.
 */
export async function GET(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "actions.read");
  if (scopeErr) return scopeErr;

  const { data, error } = await supabase.rpc("api_list_permissions", {
    _hash: await hashApiKey(raw),
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (data === null) return unauthorized();

  return Response.json({ permissions: data ?? [] });
}
