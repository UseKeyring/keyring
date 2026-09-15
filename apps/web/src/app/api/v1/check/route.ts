import { hashApiKey } from "@/lib/api-keys";
import {
  readSubjectTokenHeader,
  verifySubjectToken,
} from "@/lib/subject-tokens";
import {
  badRequest,
  bearerHash,
  checkCorsHeaders,
  misconfigured,
  publicClient,
  requireScope,
  resolveApiKey,
  unauthorized,
  withCors,
} from "../auth";

/*
 * GET /api/v1/check?permission=<slug>&subject=<external_id>
 *
 * Secret key: subject comes from the query string.
 * Publishable key: subject comes from X-Keyring-Subject-Token (JWT);
 * any ?subject= query value is ignored.
 */
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: checkCorsHeaders() });
}

export async function GET(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return withCors(unauthorized());
  const supabase = publicClient();
  if (!supabase) return withCors(misconfigured());

  const meta = await resolveApiKey(raw);
  if (!meta) return withCors(unauthorized());
  const scopeErr = requireScope(meta, "check");
  if (scopeErr) return withCors(scopeErr);

  const url = new URL(req.url);
  const permission = url.searchParams.get("permission") ?? "";
  if (!permission) {
    return withCors(badRequest("Expected ?permission=<slug>"));
  }

  let subject = "";
  if (meta.key_type === "publishable") {
    if (
      !process.env["SUBJECT_TOKEN_SECRET"] &&
      !process.env["KEYRING_SUBJECT_TOKEN_SECRET"]
    ) {
      return withCors(misconfigured());
    }
    const token = readSubjectTokenHeader(req);
    if (!token) {
      return withCors(
        badRequest("Publishable keys require X-Keyring-Subject-Token"),
      );
    }
    const claims = await verifySubjectToken(token, meta.organization_id);
    if (!claims) return withCors(unauthorized());
    subject = claims.subject;
  } else {
    subject = url.searchParams.get("subject") ?? "";
    if (!subject) {
      return withCors(
        badRequest("Expected ?subject=<external_id>&permission=<slug>"),
      );
    }
  }

  const { data, error } = await supabase.rpc("api_check", {
    _hash: await hashApiKey(raw),
    _subject: subject,
    _perm: permission,
  });
  if (error) return withCors(badRequest(error.message));
  if (data === null) return withCors(unauthorized());

  return withCors(
    Response.json({ subject, permission, allowed: data === true }),
  );
}
