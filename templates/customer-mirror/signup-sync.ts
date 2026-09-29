// Customer signup sync — deploy in YOUR Supabase project as an Edge Function
// (e.g. `keyring-signup`), then wire it to auth.users inserts via
// Dashboard → Database → Webhooks (table auth.users, event INSERT).
//
// Effect: every new login is provisioned into the workspace DEFAULT role
// (chosen in Keyring console Settings → Default role) in one call.
// POST /api/v1/subjects/provision auto-provisions the subject (fail-closed:
// holding nothing until granted) and is idempotent — double-fires upsert.
// No role slug crosses the wire: the server resolves the default, so this
// function can never choose or escalate roles.
//
// Required secrets (customer project, via `supabase secrets set`):
// KEYRING_SECRET_KEY (grants.write), KEYRING_URL (e.g. https://usekeyring.dev),
// SIGNUP_SHARED_SECRET (any random 32+ chars — also sent as the X-Signup-Key
// header on the Database Webhook, so strangers can't mint default grants).
// In your supabase/config.toml: [functions.keyring-signup] verify_jwt = false
// (Database Webhooks carry no user JWT).
Deno.serve(async (req) => {
  const secret = Deno.env.get("KEYRING_SECRET_KEY");
  const baseUrl = Deno.env.get("KEYRING_URL");
  const shared = Deno.env.get("SIGNUP_SHARED_SECRET");
  if (!secret || !baseUrl || !shared) {
    return new Response(JSON.stringify({ error: "Missing KEYRING_SECRET_KEY / KEYRING_URL / SIGNUP_SHARED_SECRET" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
  if (req.headers.get("X-Signup-Key") !== shared) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  const { record } = await req.json().catch(() => ({})) as {
    record?: { id?: string; email?: string };
  };
  const subject = record?.id;
  if (!subject) {
    return new Response(JSON.stringify({ error: "Expected { record: { id, email? } }" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const res = await fetch(`${baseUrl}/api/v1/subjects/provision`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subject, display_name: record?.email ?? undefined }),
  });
  if (!res.ok) {
    const text = await res.text();
    // 409 no_default_role: operator hasn't picked one yet — user holds
    // nothing (fail-closed); reconcile heals them once a default is set.
    return new Response(JSON.stringify({ error: `Keyring provision failed: ${res.status} ${text}` }), {
      status: 502, headers: { "Content-Type": "application/json" },
    });
  }
  const provisioned = await res.json() as { role: string; granted: boolean };

  // Provision log (see schema.sql: keyring.provision_log). The nightly
  // reconcile provisions auth users ABSENT from this table — never ones
  // present, so deliberately revoked users stay revoked. Failures here are
  // REPORTED, never swallowed: a missing row means reconcile misfires.
  let provisionLog: string = "skipped_no_env";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (supabaseUrl && serviceKey) {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.49.8");
    const admin = createClient(supabaseUrl, serviceKey);
    const { error: logError } = await admin.schema("keyring").from("provision_log").upsert(
      { subject_id: subject, role_slug: provisioned.role },
      { onConflict: "subject_id" },
    );
    provisionLog = logError ? `failed: ${logError.message}` : "written";
    if (logError) console.warn(`provision_log write failed for ${subject}: ${logError.message}`);
  } else {
    console.warn("provision_log skipped: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }

  return new Response(JSON.stringify({ ok: true, subject, role: provisioned.role, granted: provisioned.granted, provision_log: provisionLog }), {
    headers: { "Content-Type": "application/json" },
  });
});

// Alternative (zero plumbing): skip this function and grant lazily on first
// authenticated request from your own server:
//   await keyring.provisionSubject({ subject: user.id, displayName: user.email });
