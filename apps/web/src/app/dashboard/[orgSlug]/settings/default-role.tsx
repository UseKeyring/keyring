"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { isCustomerRole, logAction, useMyAccess, useRoles } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { Button } from "@keyring/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@keyring/ui/components/select";

/*
 * Workspace default role (migration 0040): new signups provisioned via
 * POST /api/v1/subjects/provision land in this role. Changing it affects
 * future signups only — existing grants are never touched.
 */
const NONE = "none";

export function DefaultRoleSection() {
  const { org, orgId } = useMyOrganization();
  const { user } = useAuth();
  const { can } = useMyAccess();
  const roles = useRoles();
  const qc = useQueryClient();

  const [selected, setSelected] = useState<string>(NONE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (org.data) setSelected(org.data.default_role_id ?? NONE);
  }, [org.data?.default_role_id]);

  const customerRoles = (roles.data ?? []).filter(isCustomerRole);
  const canEdit =
    !!org.data && (!!user && (org.data.created_by === user.id || can("organizations.manage")));

  const save = async () => {
    if (!orgId || !org.data || !user) return;
    setSaving(true);
    try {
      const next = selected === NONE ? null : selected;
      const { error } = await getSupabaseBrowserClient()
        .from("organizations")
        .update({ default_role_id: next })
        .eq("id", orgId);
      if (error) throw error;
      const role = customerRoles.find((r) => r.id === next);
      await logAction(
        user.id,
        "role.default_set",
        role ? role.slug : "(none)",
        next ?? undefined,
        orgId,
      );
      toast.success(
        role
          ? `Default role set to ${role.slug} — new signups land there`
          : "Default role cleared — provisioning is disabled",
      );
      qc.invalidateQueries({ queryKey: ["organization", orgId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save default role");
    } finally {
      setSaving(false);
    }
  };

  const dirty = (org.data?.default_role_id ?? NONE) !== selected;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="type-body-lg font-medium text-ink">Default role</h2>
        <p className="type-body-sm mt-1 text-ink-muted">
          New users are provisioned into this role automatically on signup.
          Changing it affects future signups only — existing grants are never touched.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={selected} onValueChange={setSelected} disabled={!canEdit || roles.isLoading}>
          <SelectTrigger className="sm:w-64">
            <SelectValue placeholder="Select a role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No default (provisioning disabled)</SelectItem>
            {customerRoles.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                <span className="type-mono">{r.slug}</span>
                {r.name !== r.slug ? ` — ${r.name}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canEdit && (
          <Button disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      {!canEdit && (
        <p className="type-mono text-ink-muted">
          Changing the default role requires organizations.manage.
        </p>
      )}
    </div>
  );
}
