import { after } from "next/server";
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

/*
 * KEYRING_URL written into the customer's function secrets must be the
 * publicly-reachable origin of this console. Explicit server config wins,
 * then the public build-time URL, then the origin of this very request
 * (correct for production, previews and self-hosters alike).
 */
const resolveAppUrl = (req: Request): string => {
  const trim = (s: string) => s.replace(/\/+$/, "");
  const configured = process.env["APP_URL"] ?? process.env["NEXT_PUBLIC_APP_URL"];
  if (configured?.trim()) return trim(configured.trim());
  try {
    return trim(new URL(req.url).origin);
  } catch {
    return "https://usekeyring.dev";
  }
};

type SupaClient = NonNullable<ReturnType<typeof publicClient>>;

type Ctx = {
  supabase: SupaClient;
  callerHash: string;
  projectRef: string;
  userToken: string;
  appUrl: string;
};

/*
 * POST /api/v1/integrations/supabase/verify { project_ref, supabase_token }
 * Step 3 of the connect wizard: wire the mirror on the chosen project.
 * The Supabase user token comes from the earlier projects step (browser
 * memory only, never persisted); auth here is the Keyring SECRET key with
 * scope `integrations.write` (created or pasted in the wizard).
 *
 * Returns 202 immediately — the ~50-call mirror orchestration runs in the
 * background via after() and reports progress into supabase_integrations,
 * which the console polls.
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
    project_ref?: unknown;
    supabase_token?: unknown;
  } | null;
  const projectRef = typeof body?.project_ref === "string" ? body.project_ref : "";
  const userToken = typeof body?.supabase_token === "string" ? body.supabase_token : "";
  if (!projectRef || !userToken) {
    return Response.json({ error: "Expected { project_ref, supabase_token }" }, { status: 400 });
  }

  const appUrl = resolveAppUrl(req);
  const callerHash = await hashApiKey(raw);

  // Fast project-access check — fail loudly before going async.
  let projectName = projectRef;
  try {
    const project = await mgmtGetProject(userToken, projectRef);
    projectName = project.name;
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e), step: "project" },
      { status: 500 },
    );
  }

  const initial: MgmtStep[] = [{ step: "project", ok: true, detail: projectName }];
  await supabase.rpc("api_integration_upsert", {
    _hash: callerHash,
    _project_ref: projectRef,
    _status: "pending",
    _steps: initial as never,
  });

  const ctx: Ctx = { supabase, callerHash, projectRef, userToken, appUrl };
  try {
    // Background the slow orchestration; the console polls the row below.
    after(() => runOrchestration(ctx));
  } catch {
    // `after` unavailable (older runtime) — fall back to inline so the
    // connect still attempts, even if it risks the request timeout.
    const result = await runOrchestration(ctx);
    return Response.json(result);
  }
  return Response.json({ started: true, project_ref: projectRef }, { status: 202 });
}

/** Slow orchestration (~50 Supabase management calls). Never throws — every
 *  failure is recorded into supabase_integrations for the polling console. */
async function runOrchestration(ctx: Ctx): Promise<{ ok: boolean; steps: MgmtStep[] }> {
  const { supabase, callerHash, projectRef, userToken, appUrl } = ctx;
  const steps: MgmtStep[] = [{ step: "project", ok: true }];
  try {
    const { data } = (await supabase.rpc("api_integration_upsert", {
      _hash: callerHash,
      _project_ref: projectRef,
      _status: "pending",
      _steps: steps as never,
    })) as { data: unknown };
    void data;
  } catch {
    /* status display is best-effort */
  }

  const record = async (status: "pending" | "active" | "failed") => {
    try {
      await supabase.rpc("api_integration_upsert", {
        _hash: callerHash,
        _project_ref: projectRef,
        _status: status,
        _steps: steps as never,
      });
    } catch {
      /* the steps payload in the final inline response is the truth */
    }
  };
  const fail = async (step: string, detail: string) => {
    steps.push({ step, ok: false, detail });
    await record("failed");
    return { ok: false, steps };
  };

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
  await record("pending");

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
    await record("pending");
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
  await record("pending");

  // 6. Deploy both edge functions in parallel (each bundles server-side and
  // is the slowest phase). Public HMAC endpoints → no JWT.
  try {
    const results = await Promise.allSettled([
      mgmtDeployFunction(userToken, projectRef, "keyring-applier", "keyring-applier", [
        { name: "index.ts", content: applierTs },
      ]),
      mgmtDeployFunction(userToken, projectRef, "keyring-signup", "keyring-signup", [
        { name: "index.ts", content: signupSyncTs },
      ]),
    ]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (rejected) throw rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason));
    steps.push({ step: "deploy_applier", ok: true });
    steps.push({ step: "deploy_signup", ok: true });
  } catch (e) {
    return fail("deploy_functions", e instanceof Error ? e.message : String(e));
  }
  await record("pending");

  // 7. Mirror key (server-minted, raw value lives only in this run).
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

  // 8. Webhook endpoint (we mint the secret locally and keep it — the RPC
  // only returns metadata, never the secret — then write it into the
  // customer function secrets below).
  const webhookSecret = newWebhookSecret();
  try {
    const created = (await supabase.rpc("api_create_webhook_endpoint", {
      _hash: callerHash,
      _name: "supabase mirror",
      _url: `https://${projectRef}.supabase.co/functions/v1/keyring-applier`,
      _secret: webhookSecret,
      _events: [],
    })) as { data: { id?: string } | null; error: { message: string } | null };
    if (created.error || !created.data?.id) {
      throw new Error(created.error?.message ?? "endpoint creation failed");
    }
    steps.push({ step: "webhook_endpoint", ok: true, detail: created.data.id });
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
  return { ok: true, steps };
}
