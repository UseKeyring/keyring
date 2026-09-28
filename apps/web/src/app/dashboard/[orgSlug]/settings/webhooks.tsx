"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { logAction, useMyAccess } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { Button } from "@keyring/ui/components/button";
import { CopyToClipboardInput } from "@keyring/ui/components/copy-to-clipboard-input";
import { Input } from "@keyring/ui/components/input";
import { Label } from "@keyring/ui/components/label";
import { List, ListItem } from "@keyring/ui/components/list";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@keyring/ui/components/sheet";
import { TreeMultiSelect } from "@keyring/ui/components/tree-multi-select";
import { cn } from "@keyring/ui/lib/utils";

/*
 * Outbound webhooks → customer Supabase / Neon mirrors.
 * Polar-style: status-dot list rows → per-endpoint detail page with secret,
 * deliveries table and redeliver. Endpoints fan out grant/subject/role/
 * permission changes into webhook_outbox; `webhook-dispatch` POSTs each
 * delivery HMAC-signed. The mirror's keyring.has() / keyring.can() helpers
 * read the applied rows inside customer RLS with zero per-row network calls.
 */

export const WEBHOOK_EVENTS = [
  "grant.created",
  "grant.updated",
  "grant.deleted",
  "subject.created",
  "subject.updated",
  "subject.deleted",
  "role.created",
  "role.updated",
  "role.deleted",
  "permission.created",
  "permission.updated",
  "permission.deleted",
  "role.permissions_updated",
] as const;

export type WebhookEndpointRow = {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  failure_count: number;
  last_triggered_at: string | null;
  created_at: string;
};

export type WebhookDeliveryRow = {
  id: string;
  endpoint_id: string;
  event: string;
  payload: Record<string, unknown> | null;
  status: "pending" | "sending" | "delivered" | "failed";
  attempts: number;
  http_code: number | null;
  response: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
};

export function useWebhookEndpoints() {
  const { orgId } = useMyOrganization();
  return useQuery({
    queryKey: ["webhook_endpoints", orgId],
    enabled: !!orgId,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<WebhookEndpointRow[]> => {
      // Secret is never selected — shown once at creation (typed by the
      // operator), then server-side only for HMAC signing.
      const { data, error } = await getSupabaseBrowserClient()
        .from("webhook_endpoints")
        .select("id,name,url,events,active,failure_count,last_triggered_at,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as WebhookEndpointRow[];
    },
  });
}

export function useWebhookDeliveries(endpointId?: string | null, limit = 100) {
  const { orgId } = useMyOrganization();
  return useQuery({
    queryKey: ["webhook_outbox", orgId, endpointId ?? "all"],
    enabled: !!orgId,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<WebhookDeliveryRow[]> => {
      const full =
        "id,endpoint_id,event,payload,status,attempts,http_code,response,next_retry_at,last_error,created_at,delivered_at";
      // Pre-0038 shape (no http_code / response yet).
      const legacy =
        "id,endpoint_id,event,payload,status,attempts,next_retry_at,last_error,created_at,delivered_at";
      const run = (cols: string) => {
        let q = getSupabaseBrowserClient()
          .from("webhook_outbox")
          .select(cols)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (endpointId) q = q.eq("endpoint_id", endpointId);
        return q;
      };
      const { data, error } = await run(full);
      if (error) {
        // 0038 not applied yet → read the legacy shape so the table still
        // renders (status falls back to text, no HTTP codes).
        if (/http_code|response|does not exist/i.test(error.message)) {
          const retry = await run(legacy);
          if (!retry.error) {
            return ((retry.data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
              ...r,
              http_code: null,
              response: null,
            })) as unknown as WebhookDeliveryRow[];
          }
        }
        throw error;
      }
      return ((data ?? []) as unknown) as WebhookDeliveryRow[];
    },
  });
}

/** Requeue a failed/pending delivery. Guarded server-side (0035) to only
 *  flip status back to pending — history columns are immutable to clients. */
export async function redeliverWebhook(deliveryId: string): Promise<void> {
  const { error } = await getSupabaseBrowserClient()
    .from("webhook_outbox")
    .update({
      status: "pending",
      attempts: 0,
      next_retry_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", deliveryId);
  if (error) throw error;
}

// Polar-style: reject localhost / private ranges — an outbound webhook must
// be publicly reachable or deliveries can never land.
function isPrivateIP(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 10) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 100 && b! >= 64 && b! <= 127) return true;
  }
  if (hostname.includes(":")) {
    if (/^f[cd][0-9a-f]{2}:/i.test(hostname)) return true;
    if (/^fe[89ab][0-9a-f]:/i.test(hostname)) return true;
  }
  return false;
}

export function validateWebhookUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "This field is required";
  if (!value.startsWith("https://")) return "URL must start with https://";
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(hostname)) {
      return "Webhook URLs cannot point to localhost or private IP addresses.";
    }
    if (isPrivateIP(hostname)) {
      return "Webhook URLs cannot point to localhost or private IP addresses.";
    }
  } catch {
    return "This field is required";
  }
  return null;
}

export function WebhooksSection() {
  const { org, orgId } = useMyOrganization();
  const { user } = useAuth();
  const { can } = useMyAccess();
  const router = useRouter();
  const qc = useQueryClient();
  const endpoints = useWebhookEndpoints();

  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  // Server-minted secret, shown ONCE right after creation (never again).
  const [createdSecret, setCreatedSecret] = useState<{ id: string; secret: string } | null>(null);

  const eventOptions = useMemo(() => [...WEBHOOK_EVENTS], []);
  const canRead =
    can("users.read") || can("users.manage") || can("roles.read") || can("roles.manage");
  const manageable = can("users.manage") || can("roles.manage");
  if (!canRead) return null;

  const orgSlug = org.data?.slug ?? "";
  const rows = endpoints.data ?? [];

  const openModal = () => {
    setName("");
    setUrl("");
    setUrlError(null);
    setEvents([]);
    setCreatedSecret(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setCreatedSecret(null);
  };

  const create = async () => {
    if (!orgId || !user) return;
    const err = validateWebhookUrl(url);
    setUrlError(err);
    if (err) return;
    setCreating(true);
    try {
      // No secret sent: the database mints kr_ws_live_… at creation (0036)
      // and returns it once in this readback.
      const { data, error } = await getSupabaseBrowserClient()
        .from("webhook_endpoints")
        .insert({
          organization_id: orgId,
          name: name.trim(),
          url: url.trim(),
          events,
          created_by: user.id,
        })
        .select("id,secret")
        .single();
      if (error) throw error;
      const row = data as { id: string; secret: string };
      await logAction(user.id, "webhook.created", name.trim() || url.trim(), url.trim(), orgId);
      toast.success("Webhook Endpoint Created");
      setCreatedSecret({ id: row.id, secret: row.secret });
      qc.invalidateQueries({ queryKey: ["webhook_endpoints", orgId] });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not create webhook";
      // The sheet omits `secret` on purpose (0036 trigger mints it). If that
      // migration — or 0034/0035 — hasn't been applied, the INSERT fails here.
      // Say so instead of surfacing raw PostgREST text.
      if (/webhook_endpoints|column .*secret|null value|schema cache|relation .* does not exist/i.test(message)) {
        toast.error("Webhooks tables/triggers missing — apply migrations 0034, 0035 and 0036 in the Supabase SQL editor, then retry.");
      } else {
        toast.error(message);
      }
    } finally {
      setCreating(false);
    }
  };

  const viewCreatedEndpoint = () => {
    const id = createdSecret?.id;
    closeModal();
    if (id) router.push(`/dashboard/${org.data?.slug}/settings/webhooks/${id}`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="type-body-lg font-medium text-ink">Webhooks</h2>
        <p className="type-body-sm mt-1 text-ink-muted">
          Push grant, subject, role and permission changes to your Supabase / Neon
          mirror so RLS can check <span className="type-mono">keyring.has()</span> /{" "}
          <span className="type-mono">keyring.can()</span> locally.
        </p>
      </div>

      <List>
        {rows.length > 0 ? (
          rows.map((e) => {
            const hasName = e.name.length > 0;
            return (
              <ListItem key={e.id}>
                <div className="flex min-w-0 flex-1 flex-col gap-y-1">
                  <div className="flex items-center gap-x-2 pl-0.5">
                    <span
                      className={cn(
                        "inline-block h-2 w-2 shrink-0 rounded-full",
                        e.active
                          ? "bg-emerald-500 ring-2 ring-emerald-100 dark:ring-emerald-900"
                          : "bg-gray-300 dark:bg-polar-600",
                      )}
                      title={e.active ? "Enabled" : "Disabled"}
                    />
                    {hasName ? (
                      <p className="truncate text-sm font-medium text-ink">{e.name}</p>
                    ) : (
                      <p className="truncate font-mono text-sm text-ink">{e.url}</p>
                    )}
                    {e.failure_count > 0 && (
                      <span className="type-mono shrink-0 text-[11px] text-red-600 dark:text-red-300">
                        {e.failure_count} failures
                      </span>
                    )}
                  </div>
                  {hasName && (
                    <p className="truncate pl-4 font-mono text-xs text-ink-muted">{e.url}</p>
                  )}
                  <p className="pl-4 text-sm text-ink-muted">
                    Added on{" "}
                    {new Date(e.created_at).toLocaleDateString(undefined, { dateStyle: "long" })}
                    {" · "}
                    {e.events.length === 0 ? "All events" : `${e.events.length} event${e.events.length === 1 ? "" : "s"}`}
                  </p>
                </div>
                <div className="shrink-0">
                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/dashboard/${orgSlug}/settings/webhooks/${e.id}`}>Details</Link>
                  </Button>
                </div>
              </ListItem>
            );
          })
        ) : (
          <ListItem>
            <p className="text-sm text-ink-muted">
              {org.data ? `${org.data.name} doesn't have any webhooks yet` : "No webhooks yet"}
            </p>
          </ListItem>
        )}
        <ListItem>
          <div className="flex flex-row items-center gap-x-4">
            {manageable && <Button onClick={openModal}>Add Endpoint</Button>}
            <Button className="gap-x-2" asChild variant="ghost">
              <Link href="/docs/supabase-rls" className="shrink-0">
                Documentation
                <ArrowUpRightIcon className="ml-2 inline h-4 w-4" />
              </Link>
            </Button>
          </div>
        </ListItem>
      </List>
      {!manageable && (
        <p className="type-mono text-ink-muted">
          Managing webhooks requires users.manage or roles.manage.
        </p>
      )}

      <Sheet open={modalOpen} onOpenChange={(o) => (o ? setModalOpen(true) : closeModal())}>
        <SheetContent className="overflow-y-auto p-0 sm:max-w-[540px]">
          {createdSecret ? (
            <>
              <SheetHeader className="px-8 pt-8 text-left">
                <SheetTitle className="text-xl font-normal">Endpoint created</SheetTitle>
              </SheetHeader>
              <div className="flex flex-col gap-y-8 p-8">
                <div className="flex flex-col gap-1">
                  <Label>Signing secret — copy it now</Label>
                  <CopyToClipboardInput
                    value={createdSecret.secret}
                    onCopy={() => toast.success("Secret copied — store it as KEYRING_WEBHOOK_SECRET")}
                    variant="mono"
                    ariaLabel="Webhook signing secret"
                    className="rounded-xl [&>input]:h-11"
                  />
                  <p className="type-body-sm text-ink-muted">
                    We sign every delivery with this secret (HMAC-SHA256). Copy it into
                    your applier now — it is never shown again.
                  </p>
                </div>
                <Button type="button" onClick={viewCreatedEndpoint}>
                  View endpoint
                </Button>
              </div>
            </>
          ) : (
            <>
              <SheetHeader className="px-8 pt-8 text-left">
                <SheetTitle className="text-xl font-normal">Create webhook</SheetTitle>
              </SheetHeader>
              <div className="flex flex-col gap-y-8 p-8">
            <div className="flex flex-col gap-1">
              <div className="flex flex-row items-center justify-between">
                <Label>Name</Label>
              </div>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My Webhook (optional)"
                className="h-11 rounded-xl"
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex flex-row items-center justify-between">
                <Label>URL</Label>
              </div>
              <Input
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (urlError) setUrlError(null);
                }}
                onBlur={(e) => setUrl(e.target.value.trim())}
                placeholder="https://..."
                inputMode="url"
                className={cn("h-11 rounded-xl", urlError && "border-red-500")}
              />
              {urlError && <p className="type-body-sm text-red-600">{urlError}</p>}
            </div>
            <TreeMultiSelect
              title="Events"
              options={eventOptions}
              value={events}
              onChange={setEvents}
              separator="."
              renderOptionSuffix={() => (
                <a
                  className="text-xs text-blue-400"
                  href="/docs/api-reference"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Schema
                </a>
              )}
            />
            <Button type="button" disabled={creating} onClick={() => void create()}>
              {creating ? "Creating…" : "Create"}
            </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
