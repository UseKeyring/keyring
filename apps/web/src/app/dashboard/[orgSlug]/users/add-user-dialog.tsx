"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { logAction } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import { Button } from "@keyring/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@keyring/ui/components/dialog";
import { Input } from "@keyring/ui/components/input";
import { Label } from "@keyring/ui/components/label";
import { SolarIcon } from "@keyring/ui/components/solar-icon";
import { AgentChat } from "@/components/agent-chat";

type AddUserDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AddUserDialog({ open, onOpenChange }: AddUserDialogProps) {
  const { user } = useAuth();
  const { orgId } = useMyOrganization();
  const qc = useQueryClient();
  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [showAgent, setShowAgent] = useState(false);

  const handleAgentAction = (result: { intent: string; data: unknown }) => {
    if (result.intent === "create_subject" && result.data) {
      // Refresh the subjects list
      qc.invalidateQueries({ queryKey: ["subjects"] });
      qc.invalidateQueries({ queryKey: ["grants"] });
      qc.invalidateQueries({ queryKey: ["audit_log"] });
      toast.success("User added by AI assistant");
      setShowAgent(false);
      onOpenChange(false);
    }
  };

  const reset = () => {
    setExternalId("");
    setDisplayName("");
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!externalId.trim() || !orgId) return;
    setSaving(true);
    const { error } = await getSupabaseBrowserClient().from("subjects").insert({
      external_id: externalId.trim(),
      display_name: displayName.trim() || null,
      organization_id: orgId,
    });
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (user) await logAction(user.id, "subject.created", externalId.trim());
    qc.invalidateQueries({ queryKey: ["subjects"] });
    qc.invalidateQueries({ queryKey: ["grants"] });
    qc.invalidateQueries({ queryKey: ["audit_log"] });
    toast.success("User added");
    reset();
    onOpenChange(false);
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) reset();
          onOpenChange(v);
        }}
      >
        <DialogContent className="rounded-2xl border border-hairline bg-white p-6 sm:max-w-md dark:border-polar-800 dark:bg-polar-950">
          <DialogTitle className="type-body-lg font-medium text-ink">Add user</DialogTitle>
          <DialogDescription className="type-body-sm text-ink-muted">
            External end-users of your product, keyed by your own user IDs. They never sign into this
            console.
          </DialogDescription>
          
          {!showAgent ? (
            <form onSubmit={create} className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label>External ID</Label>
                <Input
                  value={externalId}
                  onChange={(e) => setExternalId(e.target.value)}
                  placeholder="user_123"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label>Display name</Label>
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="flex justify-between gap-2">
                <Button type="button" variant="secondary" onClick={() => setShowAgent(true)}>
                  <SolarIcon name="wand" className="h-4 w-4" />
                  Create with AI
                </Button>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={saving || !externalId.trim()}>
                    {saving ? "Adding…" : "Add user"}
                  </Button>
                </div>
              </div>
            </form>
          ) : (
            <div className="mt-4">
              <Button 
                type="button" 
                variant="secondary" 
                onClick={() => setShowAgent(false)}
                className="mb-4"
              >
                <SolarIcon name="reply" className="h-4 w-4" />
                Configure manually
              </Button>
              <AgentChat context="user" onActionComplete={handleAgentAction} embedded />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
