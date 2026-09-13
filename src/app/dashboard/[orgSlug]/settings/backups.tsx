"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useMyAccess } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import { useBackups } from "@/hooks/useBackups";
import { Button } from "@/components/ui/button";
import {
  SettingsGroup,
  SettingsGroupItem,
} from "@/components/ui/settings-group";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { SettingsSkeleton } from "@/components/ui/skeletons";

interface Backup {
  id: string;
  organization_id: string;
  storage_path: string;
  size_bytes: number | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "Unknown";
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

export function BackupsSection() {
  const { org } = useMyOrganization();
  const { user } = useAuth();
  const { can } = useMyAccess();
  const { 
    backups, 
    backupsLoading, 
    backupsError, 
    createBackup, 
    isCreatingBackup,
    restoreBackup, 
    isRestoringBackup 
  } = useBackups();
  const current = org.data;

  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [selectedBackup, setSelectedBackup] = useState<Backup | null>(null);

  const handleCreateBackup = () => {
    createBackup(undefined, {
      onSuccess: () => toast.success("Backup created successfully"),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to create backup"),
    });
  };

  const handleRestoreBackup = (backup: Backup) => {
    setSelectedBackup(backup);
    setRestoreDialogOpen(true);
  };

  const confirmRestore = () => {
    if (!selectedBackup) return;
    restoreBackup(selectedBackup.id, {
      onSuccess: () => {
        toast.success("Backup restored successfully");
        setRestoreDialogOpen(false);
        setSelectedBackup(null);
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : "Failed to restore backup"),
    });
  };

  if (!current) return null;
  const canManageBackups = current.created_by === user?.id || can("backups.manage");

  return (
    <>
      <SettingsGroup>
        <SettingsGroupItem
          title="Backups"
          description="Automatic daily backups with 7-day retention. Manually create additional backups anytime."
        >
          {canManageBackups && (
            <Button
              type="button"
              size="sm"
              onClick={handleCreateBackup}
              disabled={isCreatingBackup}
            >
              {isCreatingBackup ? "Creating backup…" : "Create backup"}
            </Button>
          )}
        </SettingsGroupItem>
      </SettingsGroup>

      {backupsLoading ? (
        <SettingsSkeleton />
      ) : backupsError ? (
        <p className="type-body-sm text-ink-muted">
          Failed to load backups. {backupsError instanceof Error ? backupsError.message : ""}
        </p>
      ) : backups && backups.length > 0 ? (
        <div className="space-y-4">
          <h3 className="type-body-sm font-medium text-ink">Recent backups</h3>
          <div className="border border-hairline rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-ink-muted">Date</th>
                  <th className="px-4 py-2 text-left font-medium text-ink-muted">Size</th>
                  <th className="px-4 py-2 text-left font-medium text-ink-muted">Status</th>
                  <th className="px-4 py-2 text-right font-medium text-ink-muted">Actions</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((backup) => (
                  <tr key={backup.id} className="border-t border-hairline">
                    <td className="px-4 py-3 text-ink">{formatDate(backup.created_at)}</td>
                    <td className="px-4 py-3 text-ink-muted">{formatBytes(backup.size_bytes)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                          backup.status === "completed"
                            ? "bg-green-100 text-green-800"
                            : backup.status === "failed"
                            ? "bg-red-100 text-red-800"
                            : "bg-yellow-100 text-yellow-800"
                        }`}
                      >
                        {backup.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {backup.status === "completed" && canManageBackups && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRestoreBackup(backup)}
                        >
                          Restore
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="type-body-sm text-ink-muted">No backups available yet.</p>
      )}

      <Dialog open={restoreDialogOpen} onOpenChange={setRestoreDialogOpen}>
        <DialogContent className="rounded-2xl border border-hairline bg-white p-8 sm:max-w-[600px] dark:border-polar-800 dark:bg-polar-950">
          <DialogTitle className="text-xl font-medium text-ink">
            Restore Backup
          </DialogTitle>
          {selectedBackup && (
            <>
              <p className="type-body-sm mt-2 text-ink-muted">
                Are you sure you want to restore from the backup created on{" "}
                {formatDate(selectedBackup.created_at)}?
              </p>
              <div className="type-body-sm mt-4 text-ink-muted">
                <p className="mb-2">This will:</p>
                <ul className="list-inside list-disc space-y-1">
                  <li>Replace all current roles, permissions, and grants</li>
                  <li>Replace all subjects and their assignments</li>
                  <li>Replace audit log entries</li>
                  <li>This action cannot be undone</li>
                </ul>
              </div>
              <div className="mt-6 flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setRestoreDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={isRestoringBackup}
                  onClick={confirmRestore}
                >
                  {isRestoringBackup ? "Restoring…" : "Restore backup"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
