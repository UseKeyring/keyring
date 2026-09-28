// Customer signup sync — deploy in YOUR Supabase project as a Database Webhook
// or Edge Function triggered on auth.users insert.
//
// Effect: every new login gets a Keyring subject + base role in one call.
// POST /api/v1/grants auto-provisions the subject (fail-closed: holding
// nothing until granted), so "create user" and "give base role" collapse.
//
// Required secrets (customer project): KEYRING_SECRET_KEY, KEYRING_URL
// (e.g. https://usekeyring.dev), KEYRING_BASE_ROLE (e.g. "app_user").

Deno.serve(async (req) => {
  const secret = Deno.env.get("KEYRING_SECRET_KEY");
  const baseUrl = Deno.env.get("KEYRING_URL");
  const baseRole = Deno.env.get("KEYRING_BASE_ROLE") ?? "app_user";
  if (!secret || !baseUrl) {
    return new Response(JSON.stringify({ error: "Missing KEYRING_SECRET_KEY / KEYRING_URL" }), {
      status: 500, headers: { "Content-Type": "application/json" },
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

  const res = await fetch(`${baseUrl}/api/v1/grants`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: baseRole, subject, display_name: record?.email ?? undefined }),
  });
  if (!res.ok) {
    const text = await res.text();
    return new Response(JSON.stringify({ error: `Keyring grant failed: ${res.status} ${text}` }), {
      status: 502, headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true, subject, role: baseRole }), {
    headers: { "Content-Type": "application/json" },
  });
});

// Alternative (zero plumbing): skip this function and grant lazily on first
// authenticated request from your own server:
//   await keyring.grantRole({ role: "app_user", subject: user.id, displayName: user.email });
