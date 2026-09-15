"use client";

import { useAuditLog, useMyAccess, useProfiles } from "@/hooks/useRbac";
import { NoAccess } from "@keyring/ui/components/no-access";
import { TableSkeleton } from "@keyring/ui/components/skeletons";

export default function AuditPage() {
  const log = useAuditLog();
  const profiles = useProfiles();
  const { can, loading: accessLoading } = useMyAccess();

  if (accessLoading) {
    return <TableSkeleton rows={8} columns={4} />;
  }

  if (!can("audit.read")) {
    return <NoAccess title="Activity" action="audit.read" noun="log" />;
  }

  const nameFor = (id: string | null) =>
    (profiles.data ?? []).find((p) => p.id === id)?.email ?? "—";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Activity</h1>
        <p className="type-body-sm mt-1 text-ink-muted">
          Every change made to actions, roles and grants.
        </p>
      </div>

      {log.isLoading || profiles.isLoading ? (
        <TableSkeleton rows={8} columns={4} />
      ) : (
      <div className="overflow-hidden rounded-2xl border border-hairline bg-canvas">
        <div className="overflow-x-auto">
          <table className="type-body-sm w-full min-w-[640px]">
            <thead>
              <tr className="type-mono border-b border-hairline text-left text-ink-muted">
                <th className="px-6 py-4 font-normal md:px-8">When</th>
                <th className="px-6 py-4 font-normal md:px-8">Actor</th>
                <th className="px-6 py-4 font-normal md:px-8">Action</th>
                <th className="px-6 py-4 font-normal md:px-8">Target</th>
              </tr>
            </thead>
            <tbody>
              {(log.data ?? []).map((row) => (
                <tr key={row.id} className="border-b border-hairline last:border-0">
                  <td className="type-mono px-6 py-4 whitespace-nowrap text-ink-muted md:px-8">
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                  <td className="px-6 py-4 text-ink md:px-8">{nameFor(row.actor_id)}</td>
                  <td className="px-6 py-4 text-ink md:px-8">{row.action}</td>
                  <td className="px-6 py-4 text-ink md:px-8">{row.target ?? "—"}</td>
                </tr>
              ))}
              {!log.isLoading && (log.data ?? []).length === 0 && (
                <tr>
                  <td className="px-6 py-6 text-ink-muted md:px-8" colSpan={4}>
                    Nothing recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}
    </div>
  );
}
