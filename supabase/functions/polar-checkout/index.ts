// supabase/functions/polar-checkout/index.ts
// Creates a Polar checkout for the Pro subscription and returns its URL.
// Called authed from onboarding/settings when the user has no active
// subscription. Enterprise is sales-led (mailto on the pricing page), so
// only "pro" is accepted here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { corsHeaders, json } from "../_shared/cors.ts";
import { polarRequest, resolvePolarBaseUrl } from "../_shared/polar.ts";

const RETURN_TO_ALLOWLIST = ["/onboarding", "/dashboard/settings", "/pricing"];

const log = (step: string, data?: unknown) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, data }));
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const polarAccessToken = Deno.env.get("POLAR_ACCESS_TOKEN");
    const proProductId = Deno.env.get("POLAR_PRO_PRODUCT_ID");
    const appUrl = (Deno.env.get("APP_URL") ?? "http://localhost:3000").replace(/\/+$/, "");

    if (!supabaseUrl || !supabaseAnonKey) return json({ error: "Missing Supabase env vars" }, 500);
    if (!polarAccessToken) return json({ error: "Missing POLAR_ACCESS_TOKEN" }, 500);
    if (!proProductId) return json({ error: "Missing POLAR_PRO_PRODUCT_ID" }, 500);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) return json({ error: "Unauthorized" }, 401);

    let body: { plan?: string; returnTo?: string };
    try {
      body = (await req.json()) as { plan?: string; returnTo?: string };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (body.plan !== "pro") {
      return json({ error: 'Only the "pro" plan is sold here — Enterprise is sales-led' }, 400);
    }

    const returnTo = RETURN_TO_ALLOWLIST.includes(body.returnTo ?? "")
      ? body.returnTo!
      : "/onboarding";

    log("polar:checkout_payload", {
      productId: proProductId,
      email: user.email,
      returnTo,
      polarBaseUrl: resolvePolarBaseUrl(),
    });

    const checkout = await polarRequest<{ id: string; url: string }>(
      polarAccessToken,
      "/checkouts",
      "POST",
      {
        products: [proProductId],
        customer_email: user.email,
        // external_id links the Polar customer back to our auth user so the
        // webhook can attribute the subscription without guessing by email.
        external_id: user.id,
        success_url: `${appUrl}${returnTo}?checkout=success&checkout_id={CHECKOUT_ID}`,
        return_url: `${appUrl}${returnTo}?checkout=cancelled`,
        allow_discount_codes: true,
        metadata: {
          type: "workspace_subscription",
          supabase_user_id: user.id,
          plan_code: "pro",
        },
      },
    );

    log("polar:checkout_created", { id: checkout.id });
    return json({ checkoutUrl: checkout.url, checkoutSessionId: checkout.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    log("request:unhandled_error", { message });
    return json({ error: message }, 500);
  }
});
