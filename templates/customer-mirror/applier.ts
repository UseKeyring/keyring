// Customer applier — deploy in YOUR Supabase project as an Edge Function
// (e.g. `keyring-applier`), then paste its URL into Keyring
// Settings → Webhooks (or POST /api/v1/webhooks).
//
// What it does: verifies the Keyring HMAC signature (webhook-secret you set
// on the endpoint) and upserts/deletes rows in keyring.access — the mirror
// that keyring.has() / keyring.can() read inside RLS.
//
// Required secrets (customer project, via `supabase secrets set`):
// KEYRING_WEBHOOK_SECRET (once-shown value from endpoint creation),
// KEYRING_SECRET_KEY + KEYRING_URL (for snapshot refresh on grant events).
// verify_jwt = false in your config.toml (Keyring signs with HMAC, not Supabase JWT).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const decodeBase64 = (input: string) => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

const timingSafeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

const verify = async (rawBody: string, headers: Headers, secret: string) => {
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sig = headers.get("webhook-signature");
  if (!id || !ts || !sig) return false;
  if (Math.abs(Date.now() - Number(ts) * 1000) > 5 * 60 * 1000) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${rawBody}`)));
  for (const entry of sig.split(" ").map((e) => e.trim()).filter(Boolean)) {
    const [version, b64] = entry.split(",");
    if (version !== "v1" || !b64) continue;
    try {
      if (timingSafeEqual(expected, decodeBase64(b64))) return true;
    } catch { /* try next entry */ }
  }
  return false;
};

type Delivery = {
  id: string;
  event: string;
  organization_id: string;
  data: {
    subject?: string;
    role?: string;
    permission?: string;
    expires_at?: string | null;
  };
};

Deno.serve(async (req) => {
  const secret = Deno.env.get("KEYRING_WEBHOOK_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !supabaseUrl || !serviceKey) return json({ error: "Missing env vars" }, 500);

  const rawBody = await req.text();
  if (!(await verify(rawBody, req.headers, secret))) {
    return json({ error: "Bad signature" }, 401);
  }

  const delivery = JSON.parse(rawBody) as Delivery;
  const admin = createClient(supabaseUrl, serviceKey);
  const d = delivery.data ?? {};

  const refreshSubject = async (subject: string) => {
    // Pull the snapshot (source of truth) and replace this subject's rows.
    // Needs KEYRING_SECRET_KEY + KEYRING_URL set on this function.
    const keyringSecret = Deno.env.get("KEYRING_SECRET_KEY");
    const keyringUrl = Deno.env.get("KEYRING_URL");
    if (!keyringSecret || !keyringUrl) return;
    const res = await fetch(
      `${keyringUrl}/api/v1/subjects/access?subject=${encodeURIComponent(subject)}`,
      { headers: { Authorization: `Bearer ${keyringSecret}` } },
    );
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    const snap = await res.json() as { roles: string[]; permissions: string[] };
    await admin.schema("keyring").from("access").delete().eq("subject_id", subject);
    const rows: Array<Record<string, unknown>> = [];
    for (const role of snap.roles ?? []) {
      for (const perm of snap.permissions ?? []) {
        rows.push({ subject_id: subject, role_slug: role, perm_slug: perm });
      }
    }
    // Note: snapshot is role×perm pairs without per-grant expiry mapping;
    // per-delivery expires_at (below) carries the precise value for the
    // common single-role case. Reconcile cron refreshes the rest.
    if (rows.length > 0) {
      await admin.schema("keyring").from("access").upsert(rows, { onConflict: "subject_id,role_slug,perm_slug" });
    }
  };

  switch (delivery.event) {
    case "grant.created":
    case "grant.updated": {
      if (!d.subject || !d.role) return json({ ok: true, skipped: true });
      // Precise path: fetch the role's current permissions via snapshot,
      // then upsert with this delivery's expires_at.
      await refreshSubject(d.subject);
      if (d.expires_at) {
        await admin.schema("keyring").from("access").update({ expires_at: d.expires_at }).eq("subject_id", d.subject).eq("role_slug", d.role);
      }
      return json({ ok: true });
    }
    case "grant.deleted":
    case "subject.deleted": {
      if (!d.subject) return json({ ok: true, skipped: true });
      if (delivery.event === "grant.deleted" && d.role) {
        await admin.schema("keyring").from("access").delete().eq("subject_id", d.subject).eq("role_slug", d.role);
      } else {
        await admin.schema("keyring").from("access").delete().eq("subject_id", d.subject);
      }
      return json({ ok: true });
    }
    case "role.permissions_updated":
    case "role.updated":
    case "permission.updated":
    case "permission.deleted":
      // Role-definition changes fan out to many subjects; the cheap correct
      // move is a targeted snapshot refresh. The delivery carries the role;
      // a full-org resync is the reconcile cron's job (nightly).
      // For v1 we acknowledge — reconcile covers consistency.
      return json({ ok: true, deferred_to_reconcile: true });
    default:
      // subject.created/updated, role.created/deleted, permission.created:
      // no mirror rows change until a grant exists.
      return json({ ok: true, ignored: delivery.event });
  }
});
