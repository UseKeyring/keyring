import { hashApiKey } from "@/lib/api-keys";
import {
  bearerHash,
  forbidden,
  misconfigured,
  publicClient,
  resolveApiKey,
  unauthorized,
} from "../auth";

/*
 * GET /api/v1/roles — customer-plane roles only. The hidden console plane
 * never leaks through this API. Secret key only.
 */
export async function GET(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  if (meta.key_type !== "secret") {
    return forbidden("Publishable keys cannot list roles");
  }

  const { data, error } = await supabase.rpc("api_list_roles", {
    _hash: await hashApiKey(raw),
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (data === null) return unauthorized();

  return Response.json({ roles: data ?? [] });
}
