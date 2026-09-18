"use client";

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useMyAccess } from "@/hooks/useRbac";
import { AgentChat } from "@/components/agent-chat";
import { ConfigureManuallyButton } from "@/components/create-with-ai-button";
import { useDashboardBase } from "../../../../dashboard-chrome";

/*
 * Cloned from Polar's AIProductPage:
 * clients/apps/web/src/app/(main)/dashboard/[organization]/(header)/products/new/ai/AIProductPage.tsx
 * <DashboardBody title="Create Product" header={<Link href=".../new"><Button>Configure manually</Button></Link>}>
 *   <AIProductChat />
 * </DashboardBody>
 */
export default function NewActionAiPage() {
  const { can } = useMyAccess();
  const base = useDashboardBase();
  const qc = useQueryClient();
  const editable = can("permissions.manage");

  const handleAgentAction = (result: { intent: string; data: unknown }) => {
    if (result.intent === "create_permission" && result.data) {
      qc.invalidateQueries({ queryKey: ["permissions"] });
      toast.success("Action created by AI assistant");
    }
  };

  if (!editable) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <div>
          <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Create action</h1>
          <p className="type-body-sm mt-1 text-ink-muted">
            You need the permissions.manage action to create actions.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Create action</h1>
          <p className="type-body-sm mt-1 text-ink-muted">
            Describe the action and the assistant will create it for you.
          </p>
        </div>
        <ConfigureManuallyButton href={`${base}/actions/new`} />
      </div>

      <AgentChat context="action" onActionComplete={handleAgentAction} embedded />
    </div>
  );
}
