import { hashApiKey } from "@/lib/api-keys";
import {
  bearerHash,
  misconfigured,
  publicClient,
  requireScope,
  resolveApiKey,
  unauthorized,
} from "../../../auth";
import {
  buildLoginUrl,
  decryptLinkToken,
  defaultLinkTokenName,
  fetchLoginSession,
  generateLinkKeypair,
  generateLinkSessionId,
  SUPABASE_API_HOST,
} from "@/lib/supabase-link-crypto";
import {
  applierTs,
  mirrorSchemaSql,
  signupSyncTs,
  signupTriggerSql,
} from "@/lib/connect-templates.generated";
import {
  mgmtDeployFunction,
  mgmtGetExposedSchemas,
  mgmtGetProject,
  mgmtRunSqlFile,
  mgmtSecretNames,
  mgmtSetExposedSchemas,
  mgmtSetSecrets,
  type MgmtStep,
} from "@/lib/supabase-management";
import { newApiKey, newWebhookSecret } from "@/lib/api-keys";

/*
 * POST /api/v1/integrations/supabase/start
 * Step 1 of the CLI-style device login: generate an ECDH keypair + session,
 * stash the PRIVATE key server-side (single-use row), return the Supabase
 * login URL. Secret key, scope `integrations.write`.
 */
export async function POST(req: Request) {
  const raw = bearerHash(req);
  if (!raw) return unauthorized();
  const supabase = publicClient();
  if (!supabase) return misconfigured();

  const meta = await resolveApiKey(raw);
  if (!meta) return unauthorized();
  const scopeErr = requireScope(meta, "integrations.write");
  if (scopeErr) return scopeErr;

  const { publicKeyHex, privateKeyHex } = await generateLinkKeypair();
  const sessionId = generateLinkSessionId();
  const tokenName = defaultLinkTokenName();

  const { error } = await supabase.rpc("api_integration_session_create", {
    _hash: await hashApiKey(raw),
    _session: sessionId,
    _priv: privateKeyHex,
  });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({
    session_id: sessionId,
    login_url: buildLoginUrl(sessionId, tokenName, publicKeyHex),
  });
}

