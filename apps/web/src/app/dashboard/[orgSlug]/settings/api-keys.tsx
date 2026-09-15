"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { logAction, useMyAccess } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import { hashApiKey, newApiKey, type ApiKeyKind } from "@/lib/api-keys";
import { Button } from "@keyring/ui/components/button";
import { CopyToClipboardInput } from "@keyring/ui/components/copy-to-clipboard-input";
import { Dialog, DialogContent, DialogTitle } from "@keyring/ui/components/dialog";
import { Input } from "@keyring/ui/components/input";
import { Label } from "@keyring/ui/components/label";
import { cn } from "@keyring/ui/lib/utils";

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  key_type: ApiKeyKind;
  created_at: string;
  last_used_at: string | null;
};

export function useApiKeys() {
  const { orgId } = useMyOrganization();
  return useQuery({
    queryKey: ["api_keys", orgId],
    enabled: !!orgId,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<ApiKeyRow[]> => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("api_keys")
        .select("id,name,prefix,key_type,created_at,last_used_at")
        .is("revoked_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data as ApiKeyRow[]).map((row) => ({
        ...row,
        key_type: row.key_type === "publishable" ? "publishable" : "secret",
      }));
    },
  });
}

function TokenItem({
  token,
  rawToken,
  rootRef,
  onRevoke,
}: {
  token: ApiKeyRow;
  rawToken?: string | undefined;
  rootRef?: React.RefObject<HTMLDivElement | null> | undefined;
  onRevoke: (token: ApiKeyRow) => void;
}) {
  const isPublishable = token.key_type === "publishable";
  return (
    <div ref={rootRef} className="flex flex-col gap-y-4">
      <div className="flex flex-col gap-y-2 md:flex-row md:items-center md:justify-between md:gap-x-4">
        <div className="flex min-w-0 flex-row">
          <div className="flex min-w-0 flex-col">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="truncate text-base text-ink">{token.name}</h3>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 type-mono text-[11px]",
                  isPublishable
                    ? "bg-blue-600/10 text-blue-700 dark:text-blue-300"
                    : "bg-ink/5 text-ink-muted",
                )}
              >
                {isPublishable ? "publishable" : "secret"}
              </span>
            </div>
            <p className="type-body-sm text-ink-muted">
              <span className="text-red-500">Never expires</span> —{" "}
              {token.last_used_at ? (
                <>Last used on {new Date(token.last_used_at).toLocaleDateString()}</>
              ) : (
                "Never used"
              )}
              {" · "}
              <span className="type-mono">{token.prefix}…</span>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-row items-center justify-end gap-2">
          <Button variant="destructive" size="sm" onClick={() => onRevoke(token)}>
            Revoke
          </Button>
        </div>
      </div>
      {rawToken && (
        <>
          <CopyToClipboardInput
            value={rawToken}
            onCopy={() => toast.success("Copied to clipboard")}
            variant="mono"
            ariaLabel="New API key"
          />
          <div className="rounded-xl border border-blue-600/30 bg-blue-600/10 p-4">
            <span className="type-body-sm text-ink">
              {isPublishable ? (
                <>
                  Safe for frontend use (permission checks only). Pair it with a subject token
                  from your backend — never use it to grant or revoke.
                </>
              ) : (
                <>
                  Copy the secret key and store it server-side only. You won&rsquo;t be able to see
                  it again.
                </>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export function ApiKeysSection() {
  const { user } = useAuth();
  const { can } = useMyAccess();
  const { orgId } = useMyOrganization();
  const qc = useQueryClient();
  const keys = useApiKeys();
  const manageable = can("users.manage");

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [keyType, setKeyType] = useState<ApiKeyKind>("secret");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; key: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState("");
  const createdRef = useRef<HTMLDivElement>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["api_keys"] });
    qc.invalidateQueries({ queryKey: ["audit_log"] });
  };

  useEffect(() => {
    if (created) createdRef.current?.scrollIntoView({ block: "center" });
  }, [created]);

  const displayed = keys.data ?? [];

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !user) return;
    setCreating(true);
    try {
      const raw = newApiKey(keyType);
      const { data, error } = await getSupabaseBrowserClient()
        .from("api_keys")
        .insert({
          name: name.trim(),
          key_hash: await hashApiKey(raw),
          prefix: raw.slice(0, 12),
          key_type: keyType,
          organization_id: orgId,
          created_by: user.id,
        })
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("Could not create key");
      await logAction(user.id, "api_key.created", `${name.trim()} (${keyType})`);
      setName("");
      setKeyType("secret");
      setCreated({ id: (data as { id: string }).id, key: raw });
      setCreateOpen(false);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create key");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async () => {
    if (!revoking || !user) return;
    const { error } = await getSupabaseBrowserClient()
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", revoking.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    await logAction(user.id, "api_key.revoked", revoking.name);
    if (created?.id === revoking.id) setCreated(null);
    setRevoking(null);
    setRevokeConfirm("");
    refresh();
    toast.success("Key revoked — it stops working instantly");
  };

  if (!manageable) return null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="type-body-lg font-medium text-ink">API keys</h2>
        <p className="type-body-sm mt-1 text-ink-muted">
          Secret keys stay on your server. Publishable keys can ship in the browser for permission
          checks (with a subject token). Only hashes are stored — the full key shows once.
        </p>
      </div>

      <div className="w-full overflow-hidden rounded-2xl bg-transparent ring-1 ring-hairline dark:ring-polar-700">
        {displayed.length > 0 ? (
          displayed.map((k) => (
            <div
              key={k.id}
              className="border-t border-hairline p-5 first:border-t-0 dark:border-polar-700"
            >
              <TokenItem
                token={k}
                rawToken={created?.id === k.id ? created.key : undefined}
                rootRef={created?.id === k.id ? createdRef : undefined}
                onRevoke={(t) => {
                  setRevokeConfirm("");
                  setRevoking(t);
                }}
              />
            </div>
          ))
        ) : (
          <div className="border-t border-hairline p-5 first:border-t-0 dark:border-polar-700">
            <p className="type-body-sm text-ink-muted">You don&rsquo;t have any active API keys.</p>
          </div>
        )}
        <div className="border-t border-hairline p-5 dark:border-polar-700">
          <Button
            size="sm"
            onClick={() => {
              setKeyType("secret");
              setCreateOpen(true);
            }}
          >
            Create token
          </Button>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="rounded-2xl border border-hairline bg-white p-6 sm:max-w-md dark:border-polar-800 dark:bg-polar-950">
          <DialogTitle className="type-body-lg font-medium text-ink">Create API Token</DialogTitle>
          <form onSubmit={create} className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="E.g app-production"
              />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setKeyType("secret")}
                  className={cn(
                    "rounded-xl border px-3 py-2 text-left transition-colors",
                    keyType === "secret"
                      ? "border-ink bg-ink/5"
                      : "border-hairline hover:bg-ink/[0.02] dark:border-polar-700",
                  )}
                >
                  <div className="type-body-sm font-medium text-ink">Secret</div>
                  <div className="type-body-sm text-ink-muted">Server only — full API</div>
                </button>
                <button
                  type="button"
                  onClick={() => setKeyType("publishable")}
                  className={cn(
                    "rounded-xl border px-3 py-2 text-left transition-colors",
                    keyType === "publishable"
                      ? "border-ink bg-ink/5"
                      : "border-hairline hover:bg-ink/[0.02] dark:border-polar-700",
                  )}
                >
                  <div className="type-body-sm font-medium text-ink">Publishable</div>
                  <div className="type-body-sm text-ink-muted">Frontend — checks only</div>
                </button>
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={creating || !name.trim()}>
                {creating ? "Creating…" : "Create Token"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!revoking}
        onOpenChange={(v) => {
          if (!v) {
            setRevoking(null);
            setRevokeConfirm("");
          }
        }}
      >
        <DialogContent className="rounded-2xl border border-hairline bg-white p-6 sm:max-w-md dark:border-polar-800 dark:bg-polar-950">
          <DialogTitle className="type-body-lg font-medium text-ink">Revoke API Token</DialogTitle>
          <p className="type-body-sm mt-2 text-ink-muted">
            This will permanently revoke the token
            {revoking ? ` “${revoking.name}”` : ""}. Clients using it will start failing closed
            immediately.
          </p>
          <p className="type-body-sm mt-4 text-ink-muted">
            Please enter “{revoking?.name}” to confirm:
          </p>
          <Input
            value={revokeConfirm}
            onChange={(e) => setRevokeConfirm(e.target.value)}
            placeholder={revoking?.name ?? ""}
            className={cn("mt-2")}
          />
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setRevoking(null);
                setRevokeConfirm("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={revokeConfirm.trim() !== revoking?.name}
              onClick={() => void revoke()}
            >
              Revoke
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
