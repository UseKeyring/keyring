import { hashApiKey } from "@/lib/api-keys";
import {
  bearerHash,
  misconfigured,
  publicClient,
  requireScope,
  resolveApiKey,
  unauthorized,
} from "../../../auth";
import { decryptLinkToken, fetchLoginSession, SUPABASE_API_HOST } from "@/lib/supabase-link-crypto";
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

const randomSharedSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const isValidProjectRef = (ref: unknown): ref is string =>
  typeof ref === "string" && /^[a-z]{20}$/.test(ref);

/*
 * POST /api/v1/integrations/supabase/verify { session_id, project_ref, code }
 * Step 2: consume the session (single-use), verify the pasted code with
 * Supabase, decrypt the short-lived user token, and run the full mirror
 * orchestration with it. The token is held in memory for this call only —
 * never persisted. Secret key, scope `integrations.write`.
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

  const body = (await req.json().catch(() => null)) as {
    session_id?: unknown;
    project_ref?: unknown;
    code?: unknown;
  } | null;
  const sessionId = typeof body?.session_id === "string" ? body.session_id : "";
  const projectRef = body?.project_ref;
  const code = typeof body?.code === "string" ? body.code : "";
  if (!sessionId || !code) {
    return Response.json({ error: "Expected { session_id, project_ref, code }" }, { status: 400 });
  }
  if (!isValidProjectRef(projectRef)) {
    return Response.json({ error: "Expected project_ref like zyqkxert…" }, { status: 400 });
  }

  const callerHash = await hashApiKey(raw);
  const consumed = (await supabase.rpc("api_integration_session_consume", {
    _hash: callerHash,
    _session: sessionId,
  })) as { data: { ecdh_private_hex?: string } | null; error: { message: string } | null };
  if (consumed.error || !consumed.data?.ecdh_private_hex) {
    return Response.json(
      { error: "Unknown or already-used session — start a new connect" },
      { status: 410 },
    );
  }

  const steps: MgmtStep[] = [];
  const record = async (status: "active" | "failed") => {
    try {
      await supabase.rpc("api_integration_upsert", {
        _hash: callerHash,
        _project_ref: projectRef,
        _status: status,
        _steps: steps as never,
      });
    } catch {
      /* status display is best-effort; the steps payload below is the truth */
    }
  };
  const fail = async (step: string, detail: string) => {
    steps.push({ step, ok: false, detail });
    await record("failed");
    return Response.json({ ok: false, steps }, { status: 502 });
  };

  // 0. Verify code → short-lived user token (memory only, never stored).
  let userToken: string;
  try {
    const session = await fetchLoginSession(SUPABASE_API_HOST, sessionId, code);
    userToken = await decryptLinkToken(consumed.data.ecdh_private_hex, session);
  } catch (e) {
    return fail("supabase_login", e instanceof Error ? e.message : String(e));
  }

  // 1. Project access.
  try {
    const project = await mgmtGetProject(userToken, projectRef);
    steps.push({ step: "project", ok: true, detail: project.name });
  } catch (e) {
    return fail("project", e instanceof Error ? e.message : String(e));
  }

  // 2. pg_net (best-effort: the signup trigger degrades to silent no-op without it).
  try {
    await mgmtRunSqlFile(userToken, projectRef, "create extension if not exists pg_net with schema extensions;");
    steps.push({ step: "pg_net", ok: true });
  } catch (e) {
    steps.push({
      step: "pg_net",
      ok: false,
      detail: `${e instanceof Error ? e.message : String(e)} — continuing; enable pg_net in Dashboard → Database → Extensions or signup sync stays dormant`,
    });
  }

  // 3 + 4. Mirror schema + signup trigger (shared secret generated here).
  const signupSecret = randomSharedSecret();
  const triggerSql = signupTriggerSql
    .split("<YOUR-PROJECT-REF>").join(projectRef)
    .split("<SIGNUP_SHARED_SECRET>").join(signupSecret);
  for (const [step, sql] of [
    ["sql_schema", mirrorSchemaSql],
    ["sql_trigger", triggerSql],
  ] as const) {
    try {
      const ran = await mgmtRunSqlFile(userToken, projectRef, sql);
      steps.push({ step, ok: true, detail: `${ran} statements` });
    } catch (e) {
      return fail(step, e instanceof Error ? e.message : String(e));
    }
  }

  // 5. Expose the keyring schema (preserve whatever is already exposed).
  try {
    const current = await mgmtGetExposedSchemas(userToken, projectRef);
    if (current.includes("keyring")) {
      steps.push({ step: "postgrest", ok: true, detail: "keyring already exposed" });
    } else {
      await mgmtSetExposedSchemas(userToken, projectRef, [...current, "keyring"]);
      steps.push({ step: "postgrest", ok: true, detail: `exposed: ${[...current, "keyring"].join(",")}` });
    }
  } catch (e) {
    return fail("postgrest", e instanceof Error ? e.message : String(e));
  }

  // 6. Deploy both edge functions (public HMAC endpoints → no JWT).
  try {
    await mgmtDeployFunction(userToken, projectRef, "keyring-applier", "keyring-applier", [
      { name: "index.ts", content: applierTs },
    ]);
    steps.push({ step: "deploy_applier", ok: true });
    await mgmtDeployFunction(userToken, projectRef, "keyring-signup", "keyring-signup", [
      { name: "index.ts", content: signupSyncTs },
    ]);
    steps.push({ step: "deploy_signup", ok: true });
  } catch (e) {
    return fail("deploy_functions", e instanceof Error ? e.message : String(e));
  }

  // 7. Mirror key (server-minted, raw value lives only in this call).
  const appUrl = process.env["APP_URL"];
  if (!appUrl) {
    return fail("mirror_key", "Keyring APP_URL is not configured — cannot set KEYRING_URL");
  }
  let mirrorKey: string;
  try {
    mirrorKey = newApiKey("secret");
    const issued = (await supabase.rpc("api_issue_mirror_key", {
      _hash: callerHash,
      _name: `supabase-mirror ${projectRef}`,
      _key_hash: await hashApiKey(mirrorKey),
      _prefix: mirrorKey.slice(0, 12),
      _scopes: ["check", "grants.write"],
    })) as { data: unknown; error: { message: string } | null };
    if (issued.error || !issued.data) throw new Error(issued.error?.message ?? "key issuance failed");
    steps.push({ step: "mirror_key", ok: true });
  } catch (e) {
    return fail("mirror_key", e instanceof Error ? e.message : String(e));
  }

  // 8. Webhook endpoint (server-minted secret, returned once, used below).
  let endpointId = "";
  let webhookSecret = "";
  try {
    const created = (await supabase.rpc("api_create_webhook_endpoint", {
      _hash: callerHash,
      _name: "supabase mirror",
      _url: `https://${projectRef}.supabase.co/functions/v1/keyring-applier`,
      _secret: newWebhookSecret(),
      _events: [],
    })) as { data: { id?: string; secret?: string } | null; error: { message: string } | null };
    if (created.error || !created.data?.id || !created.data?.secret) {
      throw new Error(created.error?.message ?? "endpoint creation failed");
    }
    endpointId = created.data.id;
    webhookSecret = created.data.secret;
    steps.push({ step: "webhook_endpoint", ok: true, detail: endpointId });
  } catch (e) {
    return fail("webhook_endpoint", e instanceof Error ? e.message : String(e));
  }

  // 9. Function secrets + verify by name (values are never readable back).
  const wanted = ["KEYRING_SECRET_KEY", "KEYRING_URL", "KEYRING_WEBHOOK_SECRET", "SIGNUP_SHARED_SECRET"];
  try {
    await mgmtSetSecrets(userToken, projectRef, {
      KEYRING_SECRET_KEY: mirrorKey,
      KEYRING_URL: appUrl,
      KEYRING_WEBHOOK_SECRET: webhookSecret,
      SIGNUP_SHARED_SECRET: signupSecret,
    });
    const names = await mgmtSecretNames(userToken, projectRef);
    const missing = wanted.filter((n) => !names.includes(n));
    if (missing.length > 0) throw new Error(`secrets missing after set: ${missing.join(", ")}`);
    steps.push({ step: "secrets", ok: true, detail: wanted.join(",") });
  } catch (e) {
    return fail("secrets", e instanceof Error ? e.message : String(e));
  }

  await record("active");
  return Response.json({ ok: true, steps, endpoint_id: endpointId, project_ref: projectRef });
}
