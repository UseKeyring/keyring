// supabase/functions/backup-scheduled/index.ts
// Scheduled function to create daily backups for all organizations.
// This should be called via pg_cron or a similar scheduler.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const log = (step: string, data?: unknown) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), step, data }));
};

Deno.serve(async (req) => {
  // Only allow POST from cron or internal service
  const cronKey = req.headers.get("X-Cron-Key");
  if (cronKey !== Deno.env.get("BACKUP_CRON_KEY")) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error("Missing Supabase env vars");
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    log("scheduled_backup:start");

    // Get all organizations
    const { data: organizations, error: orgError } = await supabase
      .from("organizations")
      .select("id, name, slug");

    if (orgError) {
      throw new Error(`Failed to fetch organizations: ${orgError.message}`);
    }

    log("scheduled_backup:organizations_found", { count: organizations?.length });

    if (!organizations || organizations.length === 0) {
      return new Response(JSON.stringify({ success: true, message: "No organizations to backup" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const results = [];

    // Create backup for each organization
    for (const org of organizations) {
      try {
        log("scheduled_backup:processing_org", { orgId: org.id, orgName: org.name });

        // Create backup record
        const { data: backupRecord, error: createError } = await supabase
          .rpc("create_backup", { _organization_id: org.id });

        if (createError || !backupRecord) {
          log("scheduled_backup:create_failed", { orgId: org.id, error: createError });
          results.push({ orgId: org.id, success: false, error: createError?.message });
          continue;
        }

        try {
          // Get organization data
          const { data: backupData, error: dataError } = await supabase
            .rpc("get_organization_backup_data", { _organization_id: org.id });

          if (dataError || !backupData) {
            throw new Error(`Failed to get backup data: ${dataError?.message}`);
          }

          // Single source of truth: use the DB-issued storage_path.
          let storagePath: string | null = null;
          const { data: pathRow } = await supabase
            .from("backups")
            .select("storage_path")
            .eq("id", backupRecord)
            .single();
          storagePath = (pathRow as { storage_path?: string } | null)?.storage_path
            ?? `${org.id}/${Date.now()}.json`;

          // Upload to Supabase storage
          const { error: uploadError } = await supabase.storage
            .from("backups")
            .upload(storagePath, JSON.stringify(backupData, null, 2), {
              contentType: "application/json",
              upsert: false,
            });

          if (uploadError) {
            throw new Error(`Storage upload failed: ${uploadError.message}`);
          }

          // Mark backup as completed (sync the real key in case of fallback).
          // Falls back to the pre-0024 2-arg signature if needed.
          let { error: completeError } = await supabase
            .rpc("complete_backup", {
              _backup_id: backupRecord,
              _size_bytes: JSON.stringify(backupData).length,
              _storage_path: storagePath,
            });
          if (completeError && /storage_path|schema cache|function/i.test(completeError.message)) {
            ({ error: completeError } = await supabase.rpc("complete_backup", {
              _backup_id: backupRecord,
              _size_bytes: JSON.stringify(backupData).length,
            }));
          }

          if (completeError) {
            throw new Error(`Failed to mark backup as completed: ${completeError.message}`);
          }

          // Clean up old backups
          await supabase.rpc("cleanup_old_backups", { _organization_id: org.id });

          log("scheduled_backup:completed", { orgId: org.id, backupId: backupRecord });
          results.push({ orgId: org.id, success: true, backupId: backupRecord });

        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          log("scheduled_backup:failed", { orgId: org.id, backupId: backupRecord, error: message });

          // Mark backup as failed
          await supabase.rpc("fail_backup", { 
            _backup_id: backupRecord, 
            _error_message: message 
          });

          results.push({ orgId: org.id, success: false, error: message });
        }

      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        log("scheduled_backup:org_error", { orgId: org.id, error: message });
        results.push({ orgId: org.id, success: false, error: message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    log("scheduled_backup:completed", { 
      total: organizations.length, 
      success: successCount, 
      failed: failureCount 
    });

    return new Response(JSON.stringify({ 
      success: true, 
      total: organizations.length,
      successCount,
      failureCount,
      results 
    }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    log("scheduled_backup:unhandled_error", { message });
    return new Response(JSON.stringify({ error: message }), { 
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
