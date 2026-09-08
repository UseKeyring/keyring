// supabase/functions/polar-webhook/index.ts
// Polar webhook receiver. Verifies the Standard Webhooks signature, stores
// the raw event (deduplicated), upserts the billing customer and syncs the
// subscription row that gates workspace creation.
// Polar dashboard → webhook URL:
//   https://<project>.supabase.co/functions/v1/polar-webhook
// Events: subscription.*, checkout.*, order.*, customer.*
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const log = (step: string, data?: unknown) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, data }));
};

const mapPolarStatus = (status: string): "active" | "past_due" | "canceled" | null => {
  if (status === "active" || status === "trialing") return "active";
  if (status === "past_due" || status === "unpaid" || status === "incomplete" || status === "incomplete_expired") return "past_due";
  if (status === "canceled" || status === "cancelled" || status === "expired") return "canceled";
  // Unknown / future Polar statuses: fail open (ack without sync) so we
  // never revoke workspace creation on an event we don't understand.
  return null;
};

// Manual base64 decoder: tolerant of missing padding and URL-safe chars,
// unlike atob which throws on both in some runtimes and silently kills the
// whole verification.
const decodeBase64 = (input: string) => {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = padded.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let out = 0;
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("Invalid base64 character");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes.slice(0, out);
};

const timingSafeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

const verifyPolarSignature = async (rawBody: string, headers: Headers, secret: string) => {
  const webhookId = headers.get("webhook-id");
  const webhookTimestamp = headers.get("webhook-timestamp");
  const webhookSignature = headers.get("webhook-signature");
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    log("webhook:reject_missing_headers", {
      hasId: !!webhookId,
      hasTimestamp: !!webhookTimestamp,
      hasSignature: !!webhookSignature,
    });
    return false;
  }

  const toleranceSeconds = Number(Deno.env.get("POLAR_WEBHOOK_TOLERANCE_SECONDS") ?? "300");
  const timestampMs = Number(webhookTimestamp) * 1000;
  if (!Number.isNaN(timestampMs)) {
    const ageMs = Math.abs(Date.now() - timestampMs);
    if (ageMs > toleranceSeconds * 1000) {
      log("webhook:reject_stale_timestamp", {
        webhookId,
        ageMs,
        toleranceMs: toleranceSeconds * 1000,
      });
      return false;
    }
  }

  const payload = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  // Polar runs two signing schemes side by side (see delivery docs):
  //  - secrets minted before 8 Sept 2026: Polar HMAC, key = UTF-8 bytes of
  //    the full `whsec_…` string;
  //  - secrets minted on/after: Standard Webhooks, key = base64-decoded
  //    bytes of the part after `whsec_`.
  // Like Polar SDKs ≥1.0.0-alpha.19, try both and accept either. (Trim
  // guards pasted whitespace; it can never be part of a real secret.)
  const trimmedSecret = secret.trim();
  const candidateKeys: { scheme: string; bytes: Uint8Array }[] = [];
  if (trimmedSecret.startsWith("whsec_")) {
    try {
      candidateKeys.push({
        scheme: "standard",
        bytes: decodeBase64(trimmedSecret.slice("whsec_".length)),
      });
    } catch (err) {
      log("webhook:secret_decode_failed", {
        webhookId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  candidateKeys.push({
    scheme: "polar-hmac",
    bytes: new TextEncoder().encode(trimmedSecret),
  });

  let sawV1 = false;
  for (const { scheme, bytes } of candidateKeys) {
    const key = await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
    );

    for (const entry of webhookSignature.split(" ").map((e) => e.trim()).filter(Boolean)) {
      const [version, value] = entry.split(",", 2);
      if (version !== "v1" || !value) continue;
      sawV1 = true;
      try {
        if (timingSafeEqual(expected, decodeBase64(value))) {
          log("webhook:signature_ok", { webhookId, scheme });
          return true;
        }
      } catch (err) {
        log("webhook:signature_decode_failed", {
          webhookId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  log("webhook:reject_mismatch", {
    webhookId,
    sawV1,
    entryCount: webhookSignature.split(" ").map((e) => e.trim()).filter(Boolean).length,
    schemesTried: candidateKeys.map((k) => k.scheme),
    keyBytes: candidateKeys.map((k) => k.bytes.length),
  });
  return false;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const polarWebhookSecret = Deno.env.get("POLAR_WEBHOOK_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !polarWebhookSecret) {
    return json({ error: "Missing required env vars" }, 500);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const rawBody = await req.text();

  if (!(await verifyPolarSignature(rawBody, req.headers, polarWebhookSecret))) {
    return json({ error: "Invalid signature" }, 400);
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON payload" }, 400);
  }

  const eventType = event.type ?? "unknown";
  const rawEventId = event.id ?? event.event_id;
  let eventId: string;
  if (typeof rawEventId === "string" && rawEventId.length > 0) {
    eventId = rawEventId;
  } else {
    // No provider id: derive a deterministic idempotency key from the body
    // so Polar retries dedup on (provider, provider_event_id) instead of
    // minting a fresh randomUUID per attempt and double-syncing.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(rawBody),
    );
    eventId = "hash-" +
      [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    log("webhook:missing_event_id", { eventType, eventId });
  }

  const { error: insertError } = await admin.from("billing_webhook_events").insert({
    provider: "polar",
    provider_event_id: eventId,
    event_type: eventType,
    payload: event,
  });
  if (insertError?.code === "23505") return json({ ok: true, duplicate: true });
  if (insertError) return json({ error: insertError.message }, 500);

  const markProcessed = (error: string | null) =>
    admin
      .from("billing_webhook_events")
      .update({ processed_at: new Date().toISOString(), error })
      .eq("provider", "polar")
      .eq("provider_event_id", eventId);

  try {
    const data = event.data ?? {};
    const payload = (data?.object as Record<string, unknown> | undefined) ?? data;
    const metadata = (payload.metadata as Record<string, unknown> | undefined) ?? {};
    const customerObj = (payload.customer as Record<string, unknown> | undefined) ?? {};

    const providerCustomerId =
      (payload.customer_id as string | undefined) ??
      (customerObj.id as string | undefined) ??
      null;
    // Attribution order matters: Polar's own `user_id` is a Polar-internal
    // id, NOT our auth user (your sample payload proves it — user_id matches
    // the Polar customer, while our user is only in metadata). Only
    // metadata.supabase_user_id (set by our checkout) and the customer's
    // external_id identify our user.
    const userId =
      (metadata.supabase_user_id as string | undefined) ??
      (customerObj.external_id as string | undefined) ??
      null;
    const email =
      (payload.customer_email as string | undefined) ??
      (customerObj.email as string | undefined) ??
      null;

    // Ignore checkouts that aren't ours (e.g. other Polar products).
    const planCode = (metadata.plan_code as string | undefined) ?? null;
    const isOurs =
      (metadata.type as string | undefined) === "workspace_subscription" ||
      (planCode !== null && ["pro", "enterprise"].includes(planCode));

    if (providerCustomerId && userId) {
      const { error } = await admin.from("billing_customers").upsert(
        {
          user_id: userId,
          provider: "polar",
          provider_customer_id: providerCustomerId,
          email,
        },
        { onConflict: "provider,provider_customer_id" },
      );
      log("billing_customer:upsert_result", {
        userId,
        providerCustomerId,
        error: error?.message ?? null,
      });
    }

    if (isOurs && eventType.startsWith("subscription.")) {
      if (!userId) {
        // No attributable user (and no FK-safe fallback): ack so Polar stops
        // retrying instead of 500-looping on a meaningless event.
        log("subscription:skip_no_user_id", { eventType });
      } else {
        const rawStatus =
          (payload.status as string | undefined) ?? eventType.split(".")[1] ?? null;
        const mapped = rawStatus ? mapPolarStatus(rawStatus) : null;
        if (!rawStatus || !mapped) {
          // No attributable status (e.g. subscription.created without a
          // status payload, or a future Polar status): ack without syncing
          // so we preserve the existing row instead of revoking access.
          log("subscription:skip_unknown_status", { eventType, rawStatus });
        } else {
          const { error } = await admin.rpc("sync_subscription", {
            p_user_id: userId,
            p_plan: planCode ?? "pro",
            p_status: mapped,
            p_provider_subscription_id: (payload.id as string | undefined) ?? null,
            p_provider_customer_id: providerCustomerId,
            p_cancel_at_period_end: Boolean(payload.cancel_at_period_end),
          });
          if (error) throw new Error(`sync_subscription failed: ${error.message}`);
          log("subscription:synced", { userId, planCode, status: mapped });
        }
      }
    } else {
      log("event:ack_only", { eventType, isOurs });
    }

    await markProcessed(null);
    return json({ ok: true });
  } catch (error: any) {
    const message = error?.message ?? "Webhook processing failed";
    await markProcessed(message);
    return json({ error: message }, 500);
  }
});
