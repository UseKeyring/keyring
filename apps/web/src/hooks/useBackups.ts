"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useMyOrganization } from "./useOrganization";

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

const readFnError = async (fnError: unknown): Promise<string> => {
  const context = (fnError as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    try {
      const body = (await context.json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      // fall through to generic message
    }
  }
  return fnError instanceof Error ? fnError.message : "Request failed.";
};

export function useBackups() {
  const { org } = useMyOrganization();
  const qc = useQueryClient();
  const supabase = getSupabaseBrowserClient();
  const current = org.data;

  // Query to fetch backups
  const { data: backups, isLoading: backupsLoading, error: backupsError } = useQuery({
    queryKey: ["backups", current?.id],
    queryFn: async () => {
      if (!current?.id) return [];
      const { data, error } = await supabase
        .from("backups")
        .select("*")
        .eq("organization_id", current.id)
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return data as Backup[];
    },
    enabled: !!current?.id,
  });

  // Mutation to create backup
  const createBackupMutation = useMutation({
    mutationFn: async () => {
      if (!current?.id) throw new Error("No organization selected");
      
      const { data, error: fnError } = await supabase.functions.invoke(
        "backup-create",
        { body: { organizationId: current.id } },
      );
      
      if (fnError) {
        const errorMessage = await readFnError(fnError);
        const details = (fnError as { context?: { error?: string } })?.context?.error;
        throw new Error(details ? `${errorMessage}: ${details}` : errorMessage);
      }
      
      const apiError = (data as { error?: string; details?: string; hint?: string } | null)?.error;
      if (apiError) {
        const details = (data as { details?: string; hint?: string } | null)?.details;
        const hint = (data as { hint?: string } | null)?.hint;
        const message = details ? `${apiError}: ${details}` : apiError;
        throw new Error(hint ? `${message}. ${hint}` : message);
      }
      
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backups", current?.id] });
    },
  });

  // Mutation to restore backup
  const restoreBackupMutation = useMutation({
    mutationFn: async (backupId: string) => {
      const { data, error: fnError } = await supabase.functions.invoke(
        "backup-restore",
        { body: { backupId } },
      );
      
      if (fnError) {
        const errorMessage = await readFnError(fnError);
        const details = (fnError as { context?: { error?: string } })?.context?.error;
        throw new Error(details ? `${errorMessage}: ${details}` : errorMessage);
      }
      
      const apiError = (data as { error?: string; details?: string; hint?: string } | null)?.error;
      if (apiError) {
        const details = (data as { details?: string; hint?: string } | null)?.details;
        const hint = (data as { hint?: string } | null)?.hint;
        const message = details ? `${apiError}: ${details}` : apiError;
        throw new Error(hint ? `${message}. ${hint}` : message);
      }
      
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backups", current?.id] });
      qc.invalidateQueries({ queryKey: ["organization"] });
      qc.invalidateQueries({ queryKey: ["roles"] });
      qc.invalidateQueries({ queryKey: ["permissions"] });
      qc.invalidateQueries({ queryKey: ["subjects"] });
      qc.invalidateQueries({ queryKey: ["grants"] });
    },
  });

  return {
    backups,
    backupsLoading,
    backupsError,
    createBackup: createBackupMutation.mutate,
    isCreatingBackup: createBackupMutation.isPending,
    restoreBackup: restoreBackupMutation.mutate,
    isRestoringBackup: restoreBackupMutation.isPending,
  };
}
