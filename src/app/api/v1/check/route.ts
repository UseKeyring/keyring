import { hashApiKey } from "@/lib/api-keys";
import { badRequest, bearerHash, misconfigured, publicClient, unauthorized } from "../auth";

/*
 * GET /api/v1/check?subject=<external_id>&permission=<slug>
 * Read-only access check for backends that prefer REST over RPC.
 */
export async function GET(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const url = new URL(req.url);
  const subject = url.searchParams.get("subject") ?? "";
  const permission = url.searchParams.get("permission") ?? "";
  if (!subject || !permission) {
    return badRequest("Expected ?subject=<external_id>&permission=<slug>");
  }

  const { data, error } = await supabase.rpc("api_check", {
    _hash: await hashApiKey(raw),
    _subject: subject,
    _perm: permission,
  });
  if (error) return badRequest(error.message);
  if (data === null) return unauthorized();

  return Response.json({ subject, permission, allowed: data === true });
}
