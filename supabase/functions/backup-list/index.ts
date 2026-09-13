// supabase/functions/backup-list/index.ts
// Lists all backups for an organization.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { corsHeaders, json } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseAnonKey) {
      return json({ error: "Missing Supabase env vars" }, 500);
    }

    const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    // Forward the caller's JWT so auth.uid() / RLS work inside RPCs and selects.
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: userError,
    } = await supabaseAnon.auth.getUser(token);
    if (userError || !user) return json({ error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    const organizationId = url.searchParams.get("organizationId");

    if (!organizationId) {
      return json({ error: "organizationId is required" }, 400);
    }

    // Verify user is member of the organization
    const { data: memberCheck, error: memberError } = await supabase
      .rpc("is_org_member", { _user_id: user.id });

    if (memberError || !memberCheck) {
      return json({ error: "Not authorized to view backups for this organization" }, 403);
    }

    // Get backups for the organization
    const { data: backups, error: backupsError } = await supabase
      .from("backups")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(10);

    if (backupsError) {
      return json({ error: backupsError.message }, 500);
    }

    return json({ backups: backups || [] });

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return json({ error: message }, 500);
  }
});
