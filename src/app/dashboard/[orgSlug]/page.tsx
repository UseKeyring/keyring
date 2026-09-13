"use client";

import {
  isCustomerPermission,
  isCustomerRole,
  useGrants,
  useMyAccess,
  usePermissions,
  useRolePermissions,
  useRoles,
  useSubjects,
} from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import { useApiKeys } from "./settings/api-keys";
import { useDashboardBase } from "../dashboard-chrome";
import { PanelSkeleton, StatCardsSkeleton } from "@/components/ui/skeletons";
import {
  OverviewHeader,
  OverviewMatrix,
  OverviewSetupSteps,
  OverviewStats,
  type OverviewStat,
} from "../console-ui";

export default function OverviewPage() {
  const roles = useRoles();
  const perms = usePermissions();
  const rolePerms = useRolePermissions();
  const grants = useGrants();
  const subjects = useSubjects();
  const apiKeys = useApiKeys();
  const { org } = useMyOrganization();
  const { can, loading: accessLoading } = useMyAccess();
  const base = useDashboardBase();

  const customerRoles = (roles.data ?? []).filter(isCustomerRole);
  const customerPerms = (perms.data ?? []).filter(isCustomerPermission);
  const loading =
    roles.isLoading || perms.isLoading || rolePerms.isLoading || grants.isLoading || subjects.isLoading || accessLoading;
  const canSeeMatrix = can("roles.read") && can("permissions.read");

  const stats: (Omit<OverviewStat, "readable"> & { read: string })[] = [
    { label: "Roles", value: customerRoles.length, to: `${base}/roles`, read: "roles.read" },
    { label: "Actions", value: customerPerms.length, to: `${base}/actions`, read: "permissions.read" },
    { label: "Grants", value: grants.data?.length ?? 0, to: `${base}/users`, read: "users.read" },
    { label: "Users", value: subjects.data?.length ?? 0, to: `${base}/users`, read: "users.read" },
  ];

  return (
    <div className="space-y-6">
      <OverviewHeader orgName={org.data?.name ?? null} />

      {!loading && (
        <OverviewSetupSteps
          base={base}
          permsCount={customerPerms.length}
          rolesCount={customerRoles.length}
          usersCount={subjects.data?.length ?? 0}
          keysCount={apiKeys.data?.length ?? 0}
          orgName={org.data?.name ?? ""}
          orgSlug={org.data?.slug ?? ""}
          existingRoles={customerRoles.map((r) => r.slug)}
          existingActions={customerPerms.map((p) => p.slug)}
          subjectCount={subjects.data?.length ?? 0}
          grantCount={grants.data?.length ?? 0}
        />
      )}

      {loading ? (
        <StatCardsSkeleton />
      ) : (
        <OverviewStats
          stats={stats.map((s) => ({ ...s, readable: can(s.read) }))}
        />
      )}

      {loading ? (
        <PanelSkeleton />
      ) : canSeeMatrix ? (
        <OverviewMatrix
          roles={customerRoles}
          perms={customerPerms}
          rolePerms={rolePerms.data ?? []}
          showEmptyHint={!perms.isLoading && customerPerms.length === 0}
        />
      ) : null}
    </div>
  );
}
