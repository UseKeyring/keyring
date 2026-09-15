"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { logAction, useMyAccess } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import {
  API_KEY_SCOPES,
  PUBLISHABLE_SCOPES,
  SECRET_DEFAULT_SCOPES,
  normalizeScopes,
  scopesAllowedForKind,
  type ApiKeyScope,
} from "@/lib/api-key-scopes";
import { hashApiKey, newApiKey, type ApiKeyKind } from "@/lib/api-keys";
import { Button } from "@keyring/ui/components/button";
import { CopyToClipboardInput } from "@keyring/ui/components/copy-to-clipboard-input";
import { Dialog, DialogContent, DialogTitle } from "@keyring/ui/components/dialog";
import { Input } from "@keyring/ui/components/input";
import { Label } from "@keyring/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@keyring/ui/components/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@keyring/ui/components/sheet";
import { TreeMultiSelect } from "@keyring/ui/components/tree-multi-select";
import { cn } from "@keyring/ui/lib/utils";

const apiKeySheetClassName =
  "overflow-y-auto border-l border-hairline bg-white p-0 shadow-none sm:max-w-2xl dark:border-polar-800 dark:bg-polar-950";

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  key_type: ApiKeyKind;
  scopes: ApiKeyScope[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
};

type ExpiresIn = "P1D" | "P7D" | "P30D" | "P90D" | "P180D" | "P365D" | "no-expiration";

function expiresAtFrom(expiresIn: ExpiresIn): string | null {
  if (expiresIn === "no-expiration") return null;
  const days = Number(expiresIn.slice(1, -1));
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function formatExpires(expiresAt: string | null): ReactNode {
  if (!expiresAt) {
    return <span className="text-red-500">Never expires</span>;
  }
  const date = new Date(expiresAt);
  if (date < new Date()) {
    return (
      <span className="text-red-500">
        Expired on {date.toLocaleDateString(undefined, { dateStyle: "long" })}
      </span>
    );
  }
  return <>Expires on {date.toLocaleDateString(undefined, { dateStyle: "long" })}</>;
}

export function useApiKeys() {
  const { orgId } = useMyOrganization();
  return useQuery({
    queryKey: ["api_keys", orgId],
    enabled: !!orgId,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<ApiKeyRow[]> => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("api_keys")
        .select("id,name,prefix,key_type,scopes,created_at,last_used_at,expires_at")
        .is("revoked_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const rows = (data ?? []) as Array<{
        id: string;
        name: string;
        prefix: string;
        key_type: string;
        scopes: string[] | null;
        created_at: string;
        last_used_at: string | null;
        expires_at: string | null;
      }>;
      return rows.map((row): ApiKeyRow => ({
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        expires_at: row.expires_at,
        key_type: row.key_type === "publishable" ? "publishable" : "secret",
        scopes: normalizeScopes(row.scopes),
      }));
    },
  });
}

function TokenItem({
  token,
  rawToken,
  rootRef,
  onUpdate,
  onRevoke,
}: {
  token: ApiKeyRow;
  rawToken?: string | undefined;
  rootRef?: RefObject<HTMLDivElement | null> | undefined;
  onUpdate: (token: ApiKeyRow) => void;
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
              {formatExpires(token.expires_at)} —{" "}
              {token.last_used_at ? (
                <>Last used on {new Date(token.last_used_at).toLocaleDateString()}</>
              ) : (
                "Never used"
              )}
              {" · "}
              <span className="type-mono">{token.prefix}…</span>
            </p>
            {token.scopes.length > 0 && (
              <p className="type-body-sm mt-1 flex flex-wrap gap-1.5 text-ink-muted">
                {token.scopes.map((scope) => (
                  <span
                    key={scope}
                    className="rounded-full bg-ink/[0.04] px-2 py-0.5 type-mono text-[11px] dark:bg-polar-800"
                  >
                    {scope}
                  </span>
                ))}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-row items-center justify-end gap-2">
          <Button size="sm" onClick={() => onUpdate(token)}>
            Update
          </Button>
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
                  Copy the access token and save it somewhere safe. You won&rsquo;t be able to see
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

function ApiKeyFormFields({
  name,
  setName,
  keyType,
  onKeyTypeChange,
  expiresIn,
  setExpiresIn,
  scopes,
  setScopes,
  showTypeAndExpiry,
}: {
  name: string;
  setName: (v: string) => void;
  keyType: ApiKeyKind;
  onKeyTypeChange: (v: ApiKeyKind) => void;
  expiresIn: ExpiresIn;
  setExpiresIn: (v: ExpiresIn) => void;
  scopes: ApiKeyScope[];
  setScopes: (v: ApiKeyScope[]) => void;
  showTypeAndExpiry: boolean;
}) {
  const availableScopes = useMemo(
    () =>
      keyType === "publishable"
        ? ([...PUBLISHABLE_SCOPES] as ApiKeyScope[])
        : ([...API_KEY_SCOPES] as ApiKeyScope[]),
    [keyType],
  );

  return (
    <div className="space-y-8">
      <div>
        <Label className="mb-4 block">Name</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="E.g app-production"
        />
      </div>

      {showTypeAndExpiry && (
        <>
          <div>
            <Label className="mb-4 block">Type</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onKeyTypeChange("secret")}
                className={cn(
                  "rounded-xl border px-3 py-2 text-left transition-colors",
                  keyType === "secret"
                    ? "border-ink bg-ink/5"
                    : "border-hairline hover:bg-ink/[0.02] dark:border-polar-700",
                )}
              >
                <div className="type-body-sm font-medium text-ink">Secret</div>
                <div className="type-body-sm text-ink-muted">Server — custom scopes</div>
              </button>
              <button
                type="button"
                onClick={() => onKeyTypeChange("publishable")}
                className={cn(
                  "rounded-xl border px-3 py-2 text-left transition-colors",
                  keyType === "publishable"
                    ? "border-ink bg-ink/5"
                    : "border-hairline hover:bg-ink/[0.02] dark:border-polar-700",
                )}
              >
                <div className="type-body-sm font-medium text-ink">Publishable</div>
                <div className="type-body-sm text-ink-muted">Frontend — check only</div>
              </button>
            </div>
          </div>

          <div>
            <Label className="mb-4 block">Expiration</Label>
            <Select
              value={expiresIn}
              onValueChange={(v) => setExpiresIn(v as ExpiresIn)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select lifetime of token" />
              </SelectTrigger>
              <SelectContent>
                {[1, 7, 30, 90, 180, 365].map((days) => (
                  <SelectItem key={days} value={`P${days}D`}>
                    {days} day{days > 1 ? "s" : ""}
                  </SelectItem>
                ))}
                <SelectItem value="no-expiration">
                  <span className="text-red-500">No expiration</span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      )}

      <div>
        <TreeMultiSelect
          className="gap-4"
          title="Scopes"
          options={availableScopes}
          value={scopes}
          onChange={setScopes}
          separator="."
        />
        <p className="type-body-sm mt-2 text-ink-muted">
          Built-in Management API permissions (what this key can call) — not your app&rsquo;s
          customer actions.
        </p>
      </div>
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
  const [expiresIn, setExpiresIn] = useState<ExpiresIn>("P30D");
  const [scopes, setScopes] = useState<ApiKeyScope[]>([...SECRET_DEFAULT_SCOPES]);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ id: string; key: string } | null>(null);

  const [updating, setUpdating] = useState<ApiKeyRow | null>(null);
  const [updateName, setUpdateName] = useState("");
  const [updateScopes, setUpdateScopes] = useState<ApiKeyScope[]>([]);
  const [savingUpdate, setSavingUpdate] = useState(false);

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

  const onKeyTypeChange = (next: ApiKeyKind) => {
    setKeyType(next);
    setScopes(
      next === "publishable"
        ? [...PUBLISHABLE_SCOPES]
        : [...SECRET_DEFAULT_SCOPES],
    );
  };

  const displayed = keys.data ?? [];

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !user) return;
    const finalScopes = scopesAllowedForKind(keyType, scopes);
    if (finalScopes.length === 0) {
      toast.error("Select at least one scope");
      return;
    }
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
          scopes: finalScopes,
          expires_at: expiresAtFrom(expiresIn),
          organization_id: orgId,
          created_by: user.id,
        })
        .select("id")
        .single();
      if (error || !data) throw error ?? new Error("Could not create key");
      await logAction(
        user.id,
        "api_key.created",
        `${name.trim()} (${keyType}; ${finalScopes.join(", ")})`,
      );
      setName("");
      setKeyType("secret");
      setExpiresIn("P30D");
      setScopes([...SECRET_DEFAULT_SCOPES]);
      setCreated({ id: (data as { id: string }).id, key: raw });
      setCreateOpen(false);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create key");
    } finally {
      setCreating(false);
    }
  };

  const openUpdate = (token: ApiKeyRow) => {
    setUpdating(token);
    setUpdateName(token.name);
    setUpdateScopes(
      scopesAllowedForKind(token.key_type, token.scopes).length > 0
        ? scopesAllowedForKind(token.key_type, token.scopes)
        : token.key_type === "publishable"
          ? [...PUBLISHABLE_SCOPES]
          : [...SECRET_DEFAULT_SCOPES],
    );
  };

  const saveUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!updating || !user || !updateName.trim()) return;
    const finalScopes = scopesAllowedForKind(updating.key_type, updateScopes);
    if (finalScopes.length === 0) {
      toast.error("Select at least one scope");
      return;
    }
    setSavingUpdate(true);
    try {
      const { error } = await getSupabaseBrowserClient()
        .from("api_keys")
        .update({ name: updateName.trim(), scopes: finalScopes })
        .eq("id", updating.id);
      if (error) throw error;
      await logAction(
        user.id,
        "api_key.updated",
        `${updateName.trim()} (${finalScopes.join(", ")})`,
      );
      setUpdating(null);
      refresh();
      toast.success("API key updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update key");
    } finally {
      setSavingUpdate(false);
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
          checks (with a subject token). Pick scopes so each key only does what it needs. Only
          hashes are stored — the full key shows once.
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
                onUpdate={openUpdate}
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
              setExpiresIn("P30D");
              setScopes([...SECRET_DEFAULT_SCOPES]);
              setName("");
              setCreateOpen(true);
            }}
          >
            Create token
          </Button>
        </div>
      </div>

      <Sheet open={createOpen} onOpenChange={setCreateOpen}>
        <SheetContent side="right" className={apiKeySheetClassName}>
          <div className="flex flex-col gap-y-8 p-8">
            <SheetHeader className="space-y-0 p-0 text-left">
              <SheetTitle className="text-xl font-medium text-ink">
                Create API Token
              </SheetTitle>
            </SheetHeader>
            <form onSubmit={create} className="max-w-[700px] space-y-8">
              <ApiKeyFormFields
                name={name}
                setName={setName}
                keyType={keyType}
                onKeyTypeChange={onKeyTypeChange}
                expiresIn={expiresIn}
                setExpiresIn={setExpiresIn}
                scopes={scopes}
                setScopes={setScopes}
                showTypeAndExpiry
              />
              <Button
                type="submit"
                disabled={creating || !name.trim() || scopes.length === 0}
              >
                {creating ? "Creating…" : "Create Token"}
              </Button>
            </form>
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={!!updating}
        onOpenChange={(v) => {
          if (!v) setUpdating(null);
        }}
      >
        <SheetContent side="right" className={apiKeySheetClassName}>
          <div className="flex flex-col gap-y-8 p-8">
            <SheetHeader className="space-y-0 p-0 text-left">
              <SheetTitle className="text-xl font-medium text-ink">
                Update API Token
              </SheetTitle>
            </SheetHeader>
            {updating && (
              <form onSubmit={saveUpdate} className="max-w-[700px] space-y-8">
                <ApiKeyFormFields
                  name={updateName}
                  setName={setUpdateName}
                  keyType={updating.key_type}
                  onKeyTypeChange={() => undefined}
                  expiresIn="no-expiration"
                  setExpiresIn={() => undefined}
                  scopes={updateScopes}
                  setScopes={setUpdateScopes}
                  showTypeAndExpiry={false}
                />
                <div className="flex items-center gap-2">
                  <Button type="button" variant="ghost" onClick={() => setUpdating(null)}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={savingUpdate || !updateName.trim() || updateScopes.length === 0}
                  >
                    {savingUpdate ? "Saving…" : "Update token"}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </SheetContent>
      </Sheet>

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
