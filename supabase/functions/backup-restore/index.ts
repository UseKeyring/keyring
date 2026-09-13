// supabase/functions/backup-restore/index.ts
// Restores an organization from a backup stored in Supabase storage.
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

    const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    // Forward the caller's JWT so auth.uid() / RLS work inside RPCs.
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

    let body: { backupId?: string };
    try {
      body = (await req.json()) as { backupId?: string };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.backupId) {
      return json({ error: "backupId is required" }, 400);
    }

    const backupId = body.backupId;

    log("restore:start", { backupId, userId: user.id });

    // Get backup record
    const { data: backupRecord, error: backupError } = await supabase
      .from("backups")
      .select("*")
      .eq("id", backupId)
      .single();

    if (backupError || !backupRecord) {
      log("restore:backup_not_found", { backupId });
      return json({ error: "Backup not found" }, 404);
    }

    if (backupRecord.status !== "completed") {
      log("restore:invalid_status", { backupId, status: backupRecord.status });
      return json({ error: "Cannot restore from a backup that is not completed" }, 400);
    }

    // Verify user is manager of the organization (JWT is forwarded so RLS/auth works).
    const { data: memberCheck, error: memberError } = await supabase
      .rpc("is_org_manager", { _user_id: user.id, _org_id: backupRecord.organization_id });

    if (memberError || !memberCheck) {
      log("restore:auth_failed", { organizationId: backupRecord.organization_id, userId: user.id });
      return json({ error: "Not authorized to restore backups for this organization" }, 403);
    }

    try {
      // Download backup from storage. storage_path is the key INSIDE the
      // 'backups' bucket (e.g. '<org_id>/<epoch_ms>.json'). Older rows may
      // carry a stale 'backups/<org>/...' prefix or point at a file that was
      // never uploaded (see 0024) — surface the key so it can be repaired.
      log("restore:downloading", { backupId, storagePath: backupRecord.storage_path });
      const { data: fileData, error: downloadError } = await supabaseAdmin.storage
        .from("backups")
        .download(backupRecord.storage_path);

      if (downloadError || !fileData) {
        const detail = downloadError
          ? (downloadError.message || JSON.stringify(downloadError))
          : "empty response";
        log("restore:download_failed", {
          backupId,
          storagePath: backupRecord.storage_path,
          error: downloadError,
        });
        throw new Error(
          `Failed to download backup file "${backupRecord.storage_path}": ${detail}. ` +
            `The DB row points at a missing object — check the key exists in the 'backups' bucket ` +
            `or update backups.storage_path to the real file.`,
        );
      }

      const backupText = await fileData.text();
      const backupData = JSON.parse(backupText);

      log("restore:data_downloaded", { backupId, size: backupText.length });

      // Validate backup data structure
      if (!backupData.organization || !backupData.roles || !backupData.permissions) {
        throw new Error("Invalid backup data structure");
      }

      // Restore data in a transaction
      // Note: This is a simplified restore. In production, you'd want more sophisticated
      // conflict resolution and rollback handling.
      
      const orgId = backupRecord.organization_id;

      // Delete existing data (except organization itself)
      await supabaseAdmin.from("audit_log").delete().eq("organization_id", orgId);
      await supabaseAdmin.from("member_roles").delete().eq("organization_id", orgId);
      await supabaseAdmin.from("organization_members").delete().eq("organization_id", orgId);
      await supabaseAdmin.from("grants").delete().eq("organization_id", orgId);
      await supabaseAdmin.from("subjects").delete().eq("organization_id", orgId);
      await supabaseAdmin.from("role_permissions").delete().eq("organization_id", orgId);
      await supabaseAdmin.from("permissions").delete().eq("organization_id", orgId);
      await supabaseAdmin.from("roles").delete().eq("organization_id", orgId);

      log("restore:existing_data_cleared", { orgId });

      // Restore roles
      if (backupData.roles && Array.isArray(backupData.roles)) {
        for (const role of backupData.roles) {
          const { id, created_at, ...roleData } = role;
          await supabaseAdmin.from("roles").insert({
            ...roleData,
            organization_id: orgId,
          });
        }
      }

      // Restore permissions
      if (backupData.permissions && Array.isArray(backupData.permissions)) {
        for (const permission of backupData.permissions) {
          const { id, created_at, ...permissionData } = permission;
          await supabaseAdmin.from("permissions").insert({
            ...permissionData,
            organization_id: orgId,
          });
        }
      }

      // Restore role_permissions
      if (backupData.role_permissions && Array.isArray(backupData.role_permissions)) {
        for (const rp of backupData.role_permissions) {
          const { id, created_at, ...rpData } = rp;
          // Need to map role_id and permission_id from slugs to new IDs
          const { data: role } = await supabaseAdmin
            .from("roles")
            .select("id")
            .eq("slug", rpData.role_id)
            .eq("organization_id", orgId)
            .single();
          
          const { data: permission } = await supabaseAdmin
            .from("permissions")
            .select("id")
            .eq("slug", rpData.permission_id)
            .eq("organization_id", orgId)
            .single();

          if (role && permission) {
            await supabaseAdmin.from("role_permissions").insert({
              ...rpData,
              role_id: role.id,
              permission_id: permission.id,
              organization_id: orgId,
            });
          }
        }
      }

      // Restore subjects
      if (backupData.subjects && Array.isArray(backupData.subjects)) {
        for (const subject of backupData.subjects) {
          const { id, created_at, ...subjectData } = subject;
          await supabaseAdmin.from("subjects").insert({
            ...subjectData,
            organization_id: orgId,
          });
        }
      }

      // Restore grants
      if (backupData.grants && Array.isArray(backupData.grants)) {
        for (const grant of backupData.grants) {
          const { id, created_at, ...grantData } = grant;
          // Need to map role_id and subject_id from external identifiers
          const { data: role } = await supabaseAdmin
            .from("roles")
            .select("id")
            .eq("slug", grantData.role_id)
            .eq("organization_id", orgId)
            .single();
          
          const { data: subject } = await supabaseAdmin
            .from("subjects")
            .select("id")
            .eq("external_id", grantData.subject_id)
            .eq("organization_id", orgId)
            .single();

          if (role && subject) {
            await supabaseAdmin.from("grants").insert({
              ...grantData,
              role_id: role.id,
              subject_id: subject.id,
              organization_id: orgId,
            });
          }
        }
      }

      // Restore member_roles
      if (backupData.member_roles && Array.isArray(backupData.member_roles)) {
        for (const mr of backupData.member_roles) {
          const { id, created_at, ...mrData } = mr;
          // Need to map role_id and profile_id
          const { data: role } = await supabaseAdmin
            .from("roles")
            .select("id")
            .eq("slug", mrData.role_id)
            .eq("organization_id", orgId)
            .single();

          if (role) {
            await supabaseAdmin.from("member_roles").insert({
              ...mrData,
              role_id: role.id,
              organization_id: orgId,
            });
          }
        }
      }

      // Restore organization_members
      if (backupData.organization_members && Array.isArray(backupData.organization_members)) {
        for (const om of backupData.organization_members) {
          const { id, created_at, ...omData } = om;
          await supabaseAdmin.from("organization_members").insert({
            ...omData,
            organization_id: orgId,
          });
        }
      }

      // Restore audit log
      if (backupData.audit_log && Array.isArray(backupData.audit_log)) {
        for (const al of backupData.audit_log) {
          const { id, created_at, ...alData } = al;
          await supabaseAdmin.from("audit_log").insert({
            ...alData,
            organization_id: orgId,
          });
        }
      }

      log("restore:completed", { backupId, orgId });

      return json({
        success: true,
        backupId,
        restoredAt: new Date().toISOString(),
      });

    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      log("restore:failed", { backupId, storagePath: backupRecord.storage_path, error: message });
      return json({
        error: "Failed to restore backup",
        details: message,
        backupId,
        storagePath: backupRecord.storage_path,
        hint: "If the file is missing, check the 'backups' storage bucket or fix backups.storage_path (see 0024 repair notes).",
      }, 500);
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    log("request:unhandled_error", { message });
    return json({ error: message }, 500);
  }
});
