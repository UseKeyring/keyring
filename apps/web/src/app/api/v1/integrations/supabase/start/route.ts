import { createClient } from "@supabase/supabase-js";
import {
  buildLoginUrl,
  defaultLinkTokenName,
  generateLinkKeypair,
  generateLinkSessionId,
} from "@/lib/supabase-link-crypto";

/*
 * POST /api/v1/integrations/supabase/start
 * Step 1 of the connect wizard: generate an ECDH keypair + session, stash
 * the PRIVATE key server-side (single-use row tied to the manager's active
 * workspace), return the Supabase login URL. Auth is the console user's JWT
 * (Authorization header — the browser client keeps sessions in localStorage,
 * so no cookies are involved). No Keyring API key needed up front; the key
 * comes later, after the user picks a project.
 *
 * NOTE: the RPC goes through an untyped client carrying the user's JWT
 * (the SSR client's rpc generic resolves args to undefined with the
 * checked-in Database types). The SECURITY DEFINER function still sees
 * auth.uid() and re-checks manager permission server-side.
 */
export async function POST(req: Request) {
  const jwt = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1]?.trim();
  if (!jwt) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
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
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const {
    data: { user },
    error: userError,
  } = await authed.auth.getUser();
  if (userError || !user) {
    return Response.json({ error: "Sign in required — please sign out and back in" }, { status: 401 });
  }

  const { publicKeyHex, privateKeyHex } = await generateLinkKeypair();
  const sessionId = generateLinkSessionId();
  const tokenName = defaultLinkTokenName();

  const { error } = await authed.rpc("api_integration_session_create_user", {
    _session: sessionId,
    _priv: privateKeyHex,
  });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({
    session_id: sessionId,
    login_url: buildLoginUrl(sessionId, tokenName, publicKeyHex),
  });
}
