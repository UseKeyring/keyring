import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/integrations/supabase/server";
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
 * workspace), return the Supabase login URL. Authenticated by the console
 * user session — no Keyring API key needed up front. The key comes later,
 * after the user picks a project.
 *
 * NOTE: the RPC goes through an untyped client carrying the user's JWT
 * (the SSR client's rpc generic resolves args to undefined with the
 * checked-in Database types). The SECURITY DEFINER function still sees
 * auth.uid() and re-checks manager permission server-side.
 */
export async function POST() {
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
