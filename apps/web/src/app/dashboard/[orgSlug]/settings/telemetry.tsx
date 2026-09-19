"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { logAction, useMyAccess } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import { usePurgeTelemetry } from "@/hooks/useTelemetry";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { Button } from "@keyring/ui/components/button";
import {
  SettingsGroup,
  SettingsGroupItem,
} from "@keyring/ui/components/settings-group";
import { Switch } from "@keyring/ui/components/switch";

export function TelemetrySection() {
  const { org, orgId } = useMyOrganization();
  const { user } = useAuth();
  const { can } = useMyAccess();
  const purge = usePurgeTelemetry();
  const [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState(false);

  const current = org.data;
  if (!current) return null;
  const manageable = can("telemetry.manage");
  if (!can("telemetry.read") && !manageable) return null;

  const enabled = current.telemetry_enabled ?? true;
  const hashed = (current.telemetry_subject_mode ?? "raw") === "hashed";

  const update = async (patch: { telemetry_enabled?: boolean; telemetry_subject_mode?: string }) => {
    if (!orgId || !user) return;
    setSaving(true);
    try {
      const { error } = await getSupabaseBrowserClient()
        .from("organizations")
        .update(patch)
        .eq("id", orgId);
      if (error) throw error;
      await logAction(user.id, "telemetry.updated", JSON.stringify(patch), undefined, orgId);
      toast.success("Telemetry settings saved");
      org.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save telemetry settings");
    } finally {
      setSaving(false);
    }
  };

  const purgeNow = async () => {
    if (!orgId) return;
    setPurging(true);
    try {
      const n = await purge(orgId, 90);
      toast.success(`Purged ${n} event${n === 1 ? "" : "s"} older than 90 days`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not purge telemetry");
    } finally {
      setPurging(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="type-body-lg font-medium text-ink">Telemetry</h2>
        <p className="type-body-sm mt-1 text-ink-muted">
          Checks log automatically with the granting roles; the SDK{" "}
          <span className="type-mono">track()</span> adds manual events. Raw rows are kept
          90 days.
        </p>
      </div>
      <SettingsGroup>
        <SettingsGroupItem
          title="Collection"
          description="Turn off to stop writing new check and custom events."
        >
          <Switch
            checked={enabled}
            disabled={!manageable || saving}
            onCheckedChange={(v) => void update({ telemetry_enabled: v })}
            aria-label="Telemetry collection"
          />
        </SettingsGroupItem>
        <SettingsGroupItem
          title="Subject storage"
          description="Raw keeps external IDs for per-user leaderboards. Hashed stores SHA-256 instead."
        >
          <div className="flex overflow-hidden rounded-full border border-hairline">
            {(["raw", "hashed"] as const).map((m) => {
              const active = hashed === (m === "hashed");
              return (
                <button
                  key={m}
                  type="button"
                  disabled={!manageable || saving}
                  onClick={() => void update({ telemetry_subject_mode: m })}
                  className={`type-body-sm px-3 py-1.5 capitalize disabled:opacity-50 ${
                    active ? "bg-ink text-white" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {m}
                </button>
              );
            })}
          </div>
        </SettingsGroupItem>
        <SettingsGroupItem
          title="Retention"
          description="Delete events older than 90 days now. Requires telemetry.manage."
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!manageable || purging}
            onClick={() => void purgeNow()}
          >
            {purging ? "Purging…" : "Purge old events"}
          </Button>
        </SettingsGroupItem>
      </SettingsGroup>
      {!manageable && (
        <p className="type-mono text-ink-muted">
          Changing telemetry settings requires telemetry.manage.
        </p>
      )}
    </div>
  );
}
