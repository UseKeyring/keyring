"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  isCustomerPermission,
  isCustomerRole,
  logAction,
  useMyAccess,
  usePermissions,
  useRolePermissions,
  useRoles,
} from "@/hooks/useRbac";
import { Button } from "@keyring/ui/components/button";
import { useDashboardBase } from "../../dashboard-chrome";
import { Checkbox } from "@keyring/ui/components/checkbox";
import { NoAccess } from "@keyring/ui/components/no-access";
import { CardsSkeleton } from "@keyring/ui/components/skeletons";
import { SolarIcon } from "@keyring/ui/components/solar-icon";

export default function RolesPage() {
  const base = useDashboardBase();
  const roles = useRoles();
  const perms = usePermissions();
  const rolePerms = useRolePermissions();
  const { can, loading: accessLoading } = useMyAccess();
  const { user } = useAuth();
  const qc = useQueryClient();
  const editable = can("roles.manage");
  const loading = roles.isLoading || perms.isLoading || rolePerms.isLoading;

  if (!accessLoading && !can("roles.read")) {
    return <NoAccess title="Roles" action="roles.read" />;
  }

  const toggle = async (roleId: string, permId: string, on: boolean, label: string) => {
    const supabase = getSupabaseBrowserClient();
    if (on) {
      const { error } = await supabase
        .from("role_permissions")
        .insert({ role_id: roleId, permission_id: permId });
      if (error) {
        toast.error(error.message);
        return;
      }
    } else {
      const { error } = await supabase
        .from("role_permissions")
        .delete()
        .eq("role_id", roleId)
        .eq("permission_id", permId);
      if (error) {
        toast.error(error.message);
        return;
      }
    }
    if (user) await logAction(user.id, on ? "grant.added" : "grant.removed", label);
    qc.invalidateQueries({ queryKey: ["role_permissions"] });
    qc.invalidateQueries({ queryKey: ["audit_log"] });
  };

  const removeRole = async (id: string, s: string) => {
    const { error } = await getSupabaseBrowserClient().from("roles").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (user) await logAction(user.id, "role.deleted", s);
    qc.invalidateQueries({ queryKey: ["roles"] });
    qc.invalidateQueries({ queryKey: ["audit_log"] });
    toast.success("Role deleted");
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Roles</h1>
          <p className="type-body-sm mt-1 text-ink-muted">
            Bundles of actions. Grant them to users to decide what each subject can do.
          </p>
        </div>
        {editable && (
          <div className="flex items-center gap-2">
            <Button size="sm" asChild>
              <Link href={`${base}/roles/new`}>
                <SolarIcon name="plus" className="h-3.5 w-3.5" />
                <span className="hidden md:inline">New Role</span>
              </Link>
            </Button>
          </div>
        )}
      </div>

      {loading ? (
        <CardsSkeleton />
      ) : (
      <div className="grid gap-4 lg:grid-cols-2">
        {(roles.data ?? []).filter(isCustomerRole).map((r) => {
          return (
            <div
              key={r.id}
              className="rounded-2xl border border-hairline bg-pillar p-6 md:p-8 dark:border-transparent dark:bg-polar-800"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="type-body-lg font-medium text-ink">{r.name}</h2>
                  <div className="type-mono text-ink-muted">{r.slug}</div>
                  {r.description && (
                    <p className="type-body-sm mt-2 text-ink-muted">{r.description}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {r.is_system && (
                    <span className="type-eyebrow rounded-full border border-hairline px-2.5 py-1 text-[10px] text-ink-muted">
                      System
                    </span>
                  )}
                  {editable && !r.is_system && (
                    <Button variant="destructive" size="sm" onClick={() => removeRole(r.id, r.slug)}>
                      Delete
                    </Button>
                  )}
                </div>
              </div>

              <div className="mt-6 space-y-3 border-t border-hairline pt-6">
                {(perms.data ?? []).filter(isCustomerPermission).map((p) => {
                  const on = (rolePerms.data ?? []).some(
                    (rp) => rp.role_id === r.id && rp.permission_id === p.id,
                  );
                  return (
                    <label key={p.id} className="flex items-center gap-3">
                      <Checkbox
                        checked={on}
                        disabled={!editable}
                        onCheckedChange={(v) =>
                          toggle(r.id, p.id, Boolean(v), `${r.slug}:${p.slug}`)
                        }
                      />
                      <span className="type-body-sm text-ink">{p.slug}</span>
                      <span className="type-mono hidden text-ink-muted sm:inline">{p.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
