// supabase/functions/polar-portal/index.ts
// Opens the Polar customer portal for the caller so subscribers can manage
// or cancel. Looks up the Polar customer id from billing_customers.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { corsHeaders, json } from "../_shared/cors.ts";
import { polarRequest } from "../_shared/polar.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const polarAccessToken = Deno.env.get("POLAR_ACCESS_TOKEN");
    const appUrl = (Deno.env.get("APP_URL") ?? "http://localhost:3000").replace(/\/+$/, "");

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      return json({ error: "Missing Supabase env vars" }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, supabaseServiceRoleKey);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) return json({ error: "Unauthorized" }, 401);
    if (!polarAccessToken) return json({ error: "Missing POLAR_ACCESS_TOKEN" }, 500);

    const { data: customerRow } = await admin
      .from("billing_customers")
      .select("provider_customer_id")
      .eq("provider", "polar")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!customerRow?.provider_customer_id) {
      return json({ error: "Polar customer not found" }, 404);
    }

    const session = await polarRequest<{ customer_portal_url: string }>(
      polarAccessToken,
      "/customer-sessions",
      "POST",
      {
        customer_id: customerRow.provider_customer_id,
        return_url: `${appUrl}/dashboard/settings`,
      },
    );

    return json({ portalUrl: session.customer_portal_url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return json({ error: message }, 500);
  }
});
