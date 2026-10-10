import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/integrations/supabase/server";
import { decryptLinkToken, fetchLoginSession, SUPABASE_API_HOST } from "@/lib/supabase-link-crypto";
import { mgmtListProjects } from "@/lib/supabase-management";

/*
 * POST /api/v1/integrations/supabase/projects { session_id, code }
 * Step 2 of the connect wizard: consume the session (single-use), verify
 * the pasted code with Supabase, and list the projects the user can access.
 * Authenticated by the console user session — no Keyring API key needed.
 *
 * Returns the project list plus the short-lived Supabase token. The token
 * is held in browser memory for the rest of the wizard only (to run the
 * final orchestration) — never stored, never logged.
 *
 * NOTE: RPC via an untyped client carrying the user's JWT (see start route).
 */
export async function POST(req: Request) {
  let userToken: string;
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      return Response.json({ error: "Sign in required" }, { status: 401 });
    }
    userToken = session.access_token;
  } catch {
    return Response.json({ error: "API not configured" }, { status: 500 });
  }

  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? process.env["SUPABASE_URL"] ?? "";
  const key =
    process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ??
    process.env["SUPABASE_PUBLISHABLE_KEY"] ??
    "";
  if (!url || !key) return Response.json({ error: "API not configured" }, { status: 500 });
  const authed = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${userToken}` } },
  });

  const body = (await req.json().catch(() => null)) as {
    session_id?: unknown;
    code?: unknown;
  } | null;
  const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
  const code = typeof body?.code === "string" ? body.code : "";
  if (!sessionId || !code) {
    return Response.json({ error: "Expected { session_id, code }" }, { status: 400 });
  }

  const consumed = (await authed.rpc("api_integration_session_consume_user", {
    _session: sessionId,
  })) as { data: { ecdh_private_hex?: string } | null; error: { message: string } | null };
  if (consumed.error || !consumed.data?.ecdh_private_hex) {
    return Response.json(
      { error: "Unknown or already-used session — start a new connect" },
      { status: 410 },
    );
  }

  let sbToken: string;
  try {
    const session = await fetchLoginSession(SUPABASE_API_HOST, sessionId, code);
    sbToken = await decryptLinkToken(consumed.data.ecdh_private_hex, session);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e), step: "supabase_login" },
      { status: 500 },
    );
  }

  try {
    const projects = await mgmtListProjects(sbToken);
    return Response.json({ projects, supabase_token: sbToken });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e), step: "projects" },
      { status: 500 },
    );
  }
}
