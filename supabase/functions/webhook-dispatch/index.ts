// supabase/functions/webhook-dispatch/index.ts
// Drains public.webhook_outbox and POSTs each delivery to its endpoint URL
// with Standard-Webhooks-style HMAC-SHA256 headers:
//   webhook-id, webhook-timestamp, webhook-signature (v1,<base64>).
// Run via pg_cron every minute (or any scheduler) with BACKUP_CRON_KEY-style
// auth: header X-Cron-Key must equal WEBHOOK_DISPATCH_KEY.
// Service-role exception (like polar-webhook): no user session exists here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const log = (step: string, data?: unknown) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, data }));
};

const BATCH_LIMIT = 50;

const base64Encode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const sign = async (secret: string, payload: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64Encode(new Uint8Array(sig));
};

// Polar-style: no automatic retries. Each queued delivery is attempted ONCE;
// a failure marks it `failed` terminally and it stays there until someone
// hits Redeliver in the console (which flips it back to `pending`).
// Every attempt records `http_code` + a capped `response` snippet (0038) so
// the per-endpoint page can render Polar's Status column and Response block.

const RESPONSE_SNIPPET_LIMIT = 4000;

const snippet = (text: string): string =>
  text.length > RESPONSE_SNIPPET_LIMIT
    ? text.slice(0, RESPONSE_SNIPPET_LIMIT) + `… [truncated ${text.length - RESPONSE_SNIPPET_LIMIT} chars]`
    : text;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (req.headers.get("X-Cron-Key") !== Deno.env.get("WEBHOOK_DISPATCH_KEY")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ error: "Missing Supabase env vars" }, 500);
  const admin = createClient(supabaseUrl, serviceKey);

  // Reclaim rows orphaned by a crashed run (claimed > 5 min ago, never resolved).
  await admin.from("webhook_outbox").update({
    status: "pending",
    claimed_at: null,
  })
    .eq("status", "sending")
    .lt("claimed_at", new Date(Date.now() - 5 * 60 * 1000).toISOString());

  // Claim a batch atomically: pending only. `failed` is terminal — only a
  // manual Redeliver (back to `pending`) requeues it. No next_retry_at gate:
  // pending means due.
  const { data: batch, error: batchError } = await admin
    .from("webhook_outbox")
    .select("id, organization_id, endpoint_id, event, payload, attempts")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (batchError) {
    log("webhook-dispatch:batch_failed", { error: batchError.message });
    return json({ error: batchError.message }, 500);
  }
  if (!batch || batch.length === 0) return json({ ok: true, delivered: 0 });

  let delivered = 0;
  let failed = 0;

  for (const row of batch as Array<{
    id: string; organization_id: string; endpoint_id: string;
    event: string; payload: unknown; attempts: number;
  }>) {
    const deliveryId = crypto.randomUUID();
    let endpointFailures: number | null = null;
    try {
      await admin.from("webhook_outbox").update({
        status: "sending",
        claimed_at: new Date().toISOString(),
      }).eq("id", row.id);

      const { data: endpoint, error: epError } = await admin
        .from("webhook_endpoints")
        .select("url, secret, active, failure_count")
        .eq("id", row.endpoint_id)
        .single();
      const ep = endpoint as { url?: string; secret?: string; active?: boolean; failure_count?: number } | null;
      if (epError || !ep || !ep.active) {
        throw new Error(epError?.message ?? "endpoint inactive or deleted");
      }
      endpointFailures = (ep.failure_count ?? 0) + 1;

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({
        id: deliveryId,
        event: row.event,
        organization_id: row.organization_id,
        created_at: new Date().toISOString(),
        data: row.payload ?? {},
      });
      const signature = await sign(ep.secret as string, `${deliveryId}.${timestamp}.${body}`);

      const res = await fetch(ep.url as string, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "webhook-id": deliveryId,
          "webhook-timestamp": timestamp,
          "webhook-signature": `v1,${signature}`,
        },
        body,
      });
      const responseText = snippet(await res.text().catch(() => ""));
      if (!res.ok) {
        const err = new Error(`endpoint ${res.status}`) as Error & { httpCode?: number; responseText?: string };
        err.httpCode = res.status;
        err.responseText = responseText;
        throw err;
      }

      await admin.from("webhook_outbox").update({
        status: "delivered",
        attempts: row.attempts + 1,
        delivered_at: new Date().toISOString(),
        last_error: null,
        http_code: res.status,
        response: responseText || null,
      }).eq("id", row.id);
      await admin.from("webhook_endpoints").update({
        last_triggered_at: new Date().toISOString(),
        failure_count: 0,
      }).eq("id", row.endpoint_id);
      delivered++;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const httpCode = (err as { httpCode?: number })?.httpCode ?? null;
      const responseText = (err as { responseText?: string })?.responseText ?? null;
      await admin.from("webhook_outbox").update({
        status: "failed",
        attempts: row.attempts + 1,
        last_error: message,
        http_code: httpCode,
        response: responseText,
      }).eq("id", row.id);
      if (endpointFailures !== null) {
        await admin.from("webhook_endpoints")
          .update({ failure_count: endpointFailures })
          .eq("id", row.endpoint_id);
      }
      log("webhook-dispatch:delivery_failed", { outbox_id: row.id, error: message });
      failed++;
    }
  }

  // Hygiene: delivered rows older than 7 days are removed (queue, not audit).
  await admin.from("webhook_outbox")
    .delete()
    .eq("status", "delivered")
    .lt("delivered_at", new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());

  return json({ ok: true, delivered, failed, total: batch.length });
});
