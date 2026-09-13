// supabase/functions/backup-create/index.ts
// Creates a backup for an organization and stores it in Supabase storage.
// This function can be called manually or scheduled for automatic daily backups.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";
import { corsHeaders, json } from "../_shared/cors.ts";

const log = (step: string, data?: unknown) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, data }));
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !supabaseServiceKey || !supabaseAnonKey) {
      return json({ error: "Missing Supabase env vars" }, 500);
    }

    // Use service role for storage operations.
    // IMPORTANT: forward the caller's JWT so auth.uid() works inside RPCs.
    // Without this, PostgREST runs as anon, auth.uid() is NULL, and the
    // manager check in create_backup always fails.
    const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: userError,
    } = await supabaseAnon.auth.getUser(token);
    if (userError || !user) {
      log("auth_failed", { error: userError?.message });
      return json({ error: "Unauthorized" }, 401);
    }

    let body: { organizationId?: string };
    try {
      body = (await req.json()) as { organizationId?: string };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.organizationId) {
      return json({ error: "organizationId is required" }, 400);
    }

    const organizationId = body.organizationId;

    log("backup:start", { organizationId, userId: user.id });

    // Verify user is manager (JWT is forwarded so auth.uid() works in RPC).
    const { data: memberCheck, error: memberError } = await supabase
      .rpc("is_org_manager", { _user_id: user.id, _org_id: organizationId });

    if (memberError || !memberCheck) {
      log("backup:auth_failed", { organizationId, userId: user.id });
      return json({ error: "Not authorized to create backups for this organization" }, 403);
    }

    // Create backup record (auth.uid() is authoritative; _user_id is
    // cross-checked by the DB anti-spoof guard).
    const { data: backupRecord, error: createError } = await supabase
      .rpc("create_backup", { _organization_id: organizationId, _user_id: user.id });

    if (createError) {
      log("backup:create_failed", { organizationId, userId: user.id, error: createError });
      return json({ 
        error: "Failed to create backup record", 
        details: createError.message,
        hint: "Check if you are an organization manager and if the backups table exists"
      }, 500);
    }

    if (!backupRecord) {
      log("backup:create_no_id", { organizationId, userId: user.id });
      return json({ 
        error: "Failed to create backup record - no ID returned",
        hint: "The create_backup function did not return a backup ID"
      }, 500);
    }

    log("backup:record_created", { backupId: backupRecord });

    try {
      // Get organization data
      const { data: backupData, error: dataError } = await supabase
        .rpc("get_organization_backup_data", { _organization_id: organizationId });

      if (dataError) {
        log("backup:data_error", { backupId: backupRecord, error: dataError });
        throw new Error(`Failed to get backup data: ${dataError.message}`);
      }

      if (!backupData) {
        log("backup:no_data", { backupId: backupRecord });
        throw new Error("No backup data returned from database");
      }

      log("backup:data_retrieved", { backupId: backupRecord, size: JSON.stringify(backupData).length });

      // Single source of truth: use the DB-issued storage_path so the row
      // and the object never diverge (previously DB generated one filename
      // with postgres epoch while the edge uploaded another with Date.now()).
      // Key is relative to the 'backups' bucket, e.g. '<org_id>/<epoch_ms>.json'.
      let storagePath: string | null = null;
      const { data: pathRow, error: pathError } = await supabaseAdmin
        .from("backups")
        .select("storage_path")
        .eq("id", backupRecord)
        .single();
      if (!pathError && pathRow?.storage_path) {
        storagePath = pathRow.storage_path as string;
      } else {
        log("backup:path_fallback", { backupId: backupRecord, error: pathError });
        storagePath = `${organizationId}/${Date.now()}.json`;
      }

      // Upload to Supabase storage (service_role bypasses storage RLS)
      const { error: uploadError } = await supabaseAdmin.storage
        .from("backups")
        .upload(storagePath, JSON.stringify(backupData, null, 2), {
          contentType: "application/json",
          upsert: false,
        });

      if (uploadError) {
        log("backup:upload_error", { backupId: backupRecord, storagePath, error: uploadError });
        throw new Error(`Storage upload failed: ${uploadError.message}. Check if the 'backups' storage bucket exists.`);
      }

      log("backup:uploaded", { backupId: backupRecord, storagePath });

      // Mark backup as completed (sync the real key in case of fallback).
      // Falls back to the pre-0024 2-arg signature if the migration
      // hasn't been applied yet.
      let { error: completeError } = await supabase
        .rpc("complete_backup", {
          _backup_id: backupRecord,
          _size_bytes: JSON.stringify(backupData).length,
          _storage_path: storagePath,
        });
      if (completeError && /storage_path|schema cache|function/i.test(completeError.message)) {
        log("backup:complete_fallback_2arg", { backupId: backupRecord });
        ({ error: completeError } = await supabase.rpc("complete_backup", {
          _backup_id: backupRecord,
          _size_bytes: JSON.stringify(backupData).length,
        }));
      }

      if (completeError) {
        log("backup:complete_error", { backupId: backupRecord, error: completeError });
        throw new Error(`Failed to mark backup as completed: ${completeError.message}`);
      }

      // Clean up old backups
      const { error: cleanupError } = await supabase.rpc("cleanup_old_backups", { _organization_id: organizationId });
      if (cleanupError) {
        log("backup:cleanup_warning", { backupId: backupRecord, error: cleanupError });
        // Don't fail the backup if cleanup fails, just log it
      }

      log("backup:completed", { backupId: backupRecord });

      return json({
        success: true,
        backupId: backupRecord,
        storagePath,
        size: JSON.stringify(backupData).length,
      });

    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log("backup:failed", { backupId: backupRecord, error: message });

      // Mark backup as failed
      try {
        await supabase.rpc("fail_backup", { 
          _backup_id: backupRecord, 
          _error_message: message 
        });
      } catch (failError) {
        log("backup:fail_marker_failed", { backupId: backupRecord, error: failError });
      }

      return json({ 
        error: message,
        backupId: backupRecord,
        hint: "Check Supabase logs for more details"
      }, 500);
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    log("request:unhandled_error", { message });
    return json({ error: message }, 500);
  }
});
