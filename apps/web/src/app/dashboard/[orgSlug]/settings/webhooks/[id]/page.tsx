"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { logAction, useMyAccess } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
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
import { Switch } from "@keyring/ui/components/switch";
import { TreeMultiSelect } from "@keyring/ui/components/tree-multi-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@keyring/ui/components/table";
import { cn } from "@keyring/ui/lib/utils";
import {
  WEBHOOK_EVENTS,
  redeliverWebhook,
  useWebhookDeliveries,
  useWebhookEndpoints,
  validateWebhookUrl,
  type WebhookDeliveryRow,
} from "../../webhooks";

/*
 * Per-endpoint page, mirroring Polar's EndpointsPage layout:
 * header (Reset Secret / Delete) → name + url → secret copy input →
 * Deliveries with Status / HTTP / event-type / search filters → expandable
 * rows (details grid, Redeliver, Payload, Response).
 */
function DeliveryStatus({ delivery }: { delivery: WebhookDeliveryRow }) {
  if (delivery.http_code != null) {
    const success = delivery.http_code >= 200 && delivery.http_code <= 299;
    return (
      <span className={cn(success ? "text-green-500" : "text-red-500")}>
        {delivery.http_code}
      </span>
    );
  }
  if (delivery.status === "delivered") {
    return <span className="text-green-500">Delivered</span>;
  }
  if (delivery.status === "failed") {
    return <span className="text-red-500">Failed</span>;
  }
  return (
    <span className="text-amber-700 dark:text-amber-300">
      {delivery.status === "sending" ? "Sending" : "Pending"}
    </span>
  );
}

export default function WebhookEndpointPage() {
  const params = useParams<{ orgSlug: string; id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const { orgId } = useMyOrganization();
  const { user } = useAuth();
  const { can } = useMyAccess();

  const [statusFilter, setStatusFilter] = useState("all");
  const [httpClassFilter, setHttpClassFilter] = useState("all");
  const [eventFilter, setEventFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [redeliveringId, setRedeliveringId] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editUrlError, setEditUrlError] = useState<string | null>(null);
  const [editEvents, setEditEvents] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const endpoints = useWebhookEndpoints();
  const endpoint = (endpoints.data ?? []).find((e) => e.id === params.id) ?? null;
  const deliveries = useWebhookDeliveries(endpoint?.id ?? null);
  const eventOptions = useMemo(() => [...WEBHOOK_EVENTS], []);

  const manageable = can("users.manage") || can("roles.manage");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (deliveries.data ?? []).filter((d) => {
      if (statusFilter !== "all") {
        const succeeded = d.status === "delivered";
        if ((statusFilter === "true") !== succeeded) return false;
      }
      if (httpClassFilter !== "all") {
        if (d.http_code == null) return false;
        if (`${Math.floor(d.http_code / 100)}xx` !== httpClassFilter) return false;
      }
      if (eventFilter !== "all" && d.event !== eventFilter) return false;
      if (q) {
        const hay = `${d.event} ${d.id} ${d.last_error ?? ""} ${d.response ?? ""} ${JSON.stringify(d.payload ?? {})}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [deliveries.data, statusFilter, httpClassFilter, eventFilter, query]);

  // Polar-style: 10 rows per page, reset to first page on filter change.
  const PAGE_SIZE = 10;
  useEffect(() => {
    setPage(0);
  }, [statusFilter, httpClassFilter, eventFilter, query]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const paged = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  if (!endpoints.isLoading && !endpoint) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <Link href={`/dashboard/${params.orgSlug}/settings`} className="type-body-sm text-ink-muted hover:text-ink">
          ← Back to settings
        </Link>
        <h1 className="text-2xl font-medium text-ink">Endpoint not found</h1>
        <p className="type-body-sm text-ink-muted">
          It may have been deleted, or you lack access to this workspace.
        </p>
      </div>
    );
  }

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["webhook_endpoints", orgId] });
    qc.invalidateQueries({ queryKey: ["webhook_outbox", orgId] });
  };

  const toggle = async (active: boolean) => {
    if (!endpoint || !orgId || !user) return;
    setToggling(true);
    try {
      const { error } = await getSupabaseBrowserClient()
        .from("webhook_endpoints")
        .update({ active })
        .eq("id", endpoint.id);
      if (error) throw error;
      await logAction(user.id, active ? "webhook.activated" : "webhook.paused", endpoint.name || endpoint.url, endpoint.id, orgId);
      toast.success(active ? "Endpoint enabled — it will now receive events" : "Endpoint disabled — it will no longer receive events");
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update endpoint");
    } finally {
      setToggling(false);
    }
  };

  const resetSecret = async () => {
    if (!endpoint || !orgId || !user) return;
    setResetting(true);
    try {
      // Server mints the replacement (0036 fill trigger): NULL the secret,
      // then read the fresh value back ONCE.
      const { data, error } = await getSupabaseBrowserClient()
        .from("webhook_endpoints")
        .update({ secret: null })
        .eq("id", endpoint.id)
        .select("secret")
        .single();
      if (error) throw error;
      await logAction(user.id, "webhook.secret_reset", endpoint.name || endpoint.url, endpoint.id, orgId);
      setRevealedSecret((data as { secret: string }).secret);
      setResetOpen(false);
      toast.success("Secret reset — copy it into your applier now");
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reset secret");
    } finally {
      setResetting(false);
    }
  };

  const destroy = async () => {
    if (!endpoint || !orgId || !user) return;
    setDeleting(true);
    try {
      const { error } = await getSupabaseBrowserClient()
        .from("webhook_endpoints")
        .delete()
        .eq("id", endpoint.id);
      if (error) throw error;
      await logAction(user.id, "webhook.deleted", endpoint.name || endpoint.url, endpoint.id, orgId);
      toast.success("Endpoint deleted");
      router.push(`/dashboard/${params.orgSlug}/settings`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete endpoint");
    } finally {
      setDeleting(false);
    }
  };

  const redeliver = async (deliveryId: string) => {
    setRedeliveringId(deliveryId);
    try {
      await redeliverWebhook(deliveryId);
      toast.success("Redelivery queued — the dispatcher picks it up within a minute");
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not queue redelivery");
    } finally {
      setRedeliveringId(null);
    }
  };

  const openEdit = () => {
    if (!endpoint) return;
    setEditName(endpoint.name);
    setEditUrl(endpoint.url);
    setEditUrlError(null);
    setEditEvents([...endpoint.events]);
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!endpoint || !orgId || !user) return;
    const err = validateWebhookUrl(editUrl);
    setEditUrlError(err);
    if (err) return;
    setSaving(true);
    try {
      const { error } = await getSupabaseBrowserClient()
        .from("webhook_endpoints")
        .update({
          name: editName.trim(),
          url: editUrl.trim(),
          events: editEvents,
        })
        .eq("id", endpoint.id);
      if (error) throw error;
      await logAction(user.id, "webhook.updated", editName.trim() || editUrl.trim(), endpoint.id, orgId);
      toast.success("Webhook Endpoint Updated");
      setEditOpen(false);
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not update endpoint");
    } finally {
      setSaving(false);
    }
  };

  const copyPayload = async (payload: unknown) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      toast.success("Payload copied to clipboard");
    } catch {
      toast.error("Could not copy payload");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div>
        <Link href={`/dashboard/${params.orgSlug}/settings`} className="type-body-sm text-ink-muted hover:text-ink">
          ← Webhooks
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-medium text-ink">
              {endpoint?.name || endpoint?.url || "Webhook"}
            </h1>
            {!!endpoint?.name && (
              <p className="mt-1 break-all font-mono text-sm text-ink-muted">{endpoint.url}</p>
            )}
          </div>
          {manageable && endpoint && (
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="secondary" size="sm" onClick={openEdit}>
                Edit
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setResetOpen(true)}>
                Reset Secret
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
                Delete
              </Button>
            </div>
          )}
        </div>
      </div>

      {endpoint && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-row items-center justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="type-body-sm text-ink-muted">
                Added on {new Date(endpoint.created_at).toLocaleDateString(undefined, { dateStyle: "long" })}
                {" · "}
                {endpoint.events.length === 0 ? "All events" : endpoint.events.join(", ")}
              </p>
              {endpoint.failure_count > 0 && (
                <p className="type-body-sm text-red-600 dark:text-red-300">
                  {endpoint.failure_count} recent failures — check deliveries below.
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-sm text-ink-muted" id="webhook-status-label">
                {endpoint.active ? "Enabled" : "Disabled"}
              </span>
              <Switch
                checked={endpoint.active}
                disabled={!manageable || toggling}
                onCheckedChange={(v) => void toggle(v)}
                aria-labelledby="webhook-status-label"
              />
            </div>
          </div>
          {manageable && (
            <CopyToClipboardInput
              value={revealedSecret ?? "••••••••••••••••••••••••••••••••"}
              onCopy={() => revealedSecret && toast.success("Secret copied")}
              {...(revealedSecret ? { buttonLabel: "Copy Secret" } : {})}
              variant="mono"
              ariaLabel="Webhook signing secret"
            />
          )}
          {revealedSecret && (
            <p className="type-body-sm text-ink-muted">
              New secret above — copy it into your applier as{" "}
              <span className="type-mono">KEYRING_WEBHOOK_SECRET</span>. It will not be shown again.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-4">
        <h2 className="text-xl font-medium text-ink">Deliveries</h2>
        {(deliveries.data ?? []).some((d) => d.status === "pending" && d.attempts === 0) && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="type-body-sm text-ink">
              {(deliveries.data ?? []).filter((d) => d.status === "pending" && d.attempts === 0).length} deliver{(deliveries.data ?? []).filter((d) => d.status === "pending" && d.attempts === 0).length === 1 ? "y" : "ies"} queued but never picked up.
            </p>
            <p className="type-body-sm mt-1 text-ink-muted">
              Rows are queued by the database trigger — 0 attempts means the{" "}
              <span className="type-mono">webhook-dispatch</span> function has never run.
              Deploy it on the Keyring project and schedule it every minute (see{" "}
              <Link href="/docs/api-reference" className="underline">API reference → Webhooks</Link>
              ), then use Redeliver if needed.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-auto min-w-32">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="true">Succeeded</SelectItem>
              <SelectItem value="false">Failed</SelectItem>
            </SelectContent>
          </Select>
          <Select value={httpClassFilter} onValueChange={setHttpClassFilter}>
            <SelectTrigger className="w-auto min-w-32">
              <SelectValue placeholder="HTTP Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All HTTP Responses</SelectItem>
              <SelectItem value="2xx">2xx Success</SelectItem>
              <SelectItem value="3xx">3xx Redirect</SelectItem>
              <SelectItem value="4xx">4xx Client Error</SelectItem>
              <SelectItem value="5xx">5xx Server Error</SelectItem>
            </SelectContent>
          </Select>
          <Select value={eventFilter} onValueChange={setEventFilter}>
            <SelectTrigger className="w-auto min-w-48">
              <SelectValue placeholder="Event type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All event types</SelectItem>
              {WEBHOOK_EVENTS.map((e) => (
                <SelectItem key={e} value={e}>
                  <span className="type-mono">{e}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Deliveries"
            className="w-auto min-w-48"
          />
        </div>

        <div className="overflow-hidden rounded-2xl border border-hairline">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Sent At</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="type-body-sm text-ink-muted">
                    Loading deliveries…
                  </TableCell>
                </TableRow>
              ) : deliveries.isError ? (
                <TableRow>
                  <TableCell colSpan={5}>
                    <p className="type-body-sm text-red-600 dark:text-red-300">
                      Could not load deliveries:{" "}
                      {deliveries.error instanceof Error
                        ? deliveries.error.message
                        : "Unknown error"}
                    </p>
                    <p className="type-body-sm mt-1 text-ink-muted">
                      The outbox tables/columns may be missing — apply migrations
                      0034, 0035, 0037 and 0038 in the Supabase SQL editor, then retry.
                    </p>
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="type-body-sm text-ink-muted">
                    No deliveries match — change a grant, role or subject to trigger one.
                  </TableCell>
                </TableRow>
              ) : (
                paged.map((d) => {
                  const expanded = expandedId === d.id;
                  const payloadText = d.payload ? JSON.stringify(d.payload, null, 2) : null;
                  return (
                    <Fragment key={d.id}>
                      <TableRow key={d.id} className={cn(expanded && "border-b-0")}>
                        <TableCell className="w-10">
                          <button
                            type="button"
                            aria-label={expanded ? "Collapse" : "Expand"}
                            onClick={() => setExpandedId(expanded ? null : d.id)}
                            className="text-ink-muted hover:text-ink"
                          >
                            {expanded ? (
                              <ChevronDownIcon className="h-4 w-4" />
                            ) : (
                              <ChevronRightIcon className="h-4 w-4" />
                            )}
                          </button>
                        </TableCell>
                        <TableCell>
                          <span className="type-mono text-xs break-all">{d.id}</span>
                        </TableCell>
                        <TableCell>
                          <DeliveryStatus delivery={d} />
                        </TableCell>
                        <TableCell>
                          <pre className="type-mono text-xs">{d.event}</pre>
                        </TableCell>
                        <TableCell className="text-right type-mono text-xs text-ink-muted">
                          {new Date(d.created_at).toLocaleString(undefined, {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow key={`${d.id}-detail`}>
                          <TableCell colSpan={5}>
                            <div className="flex flex-col gap-y-4 py-2">
                              <div className="grid w-fit grid-cols-2 gap-2 text-sm">
                                <div className="text-ink-muted">Delivery ID</div>
                                <code className="type-mono text-xs break-all">{d.id}</code>
                                <div className="text-ink-muted">Event</div>
                                <code className="type-mono text-xs">{d.event}</code>
                                <div className="text-ink-muted">Sent at</div>
                                <code className="type-mono text-xs">
                                  {new Date(d.created_at).toLocaleString()}
                                </code>
                                {d.delivered_at && (
                                  <>
                                    <div className="text-ink-muted">Delivered at</div>
                                    <code className="type-mono text-xs">
                                      {new Date(d.delivered_at).toLocaleString()}
                                    </code>
                                  </>
                                )}
                                <div className="text-ink-muted">Attempts</div>
                                <code className="type-mono text-xs">{d.attempts}</code>
                              </div>
                              {(d.status === "failed" || d.status === "pending") && manageable && (
                                <div>
                                  <Button
                                    disabled={redeliveringId === d.id}
                                    onClick={() => void redeliver(d.id)}
                                  >
                                    {redeliveringId === d.id ? "Queueing…" : "Redeliver"}
                                  </Button>
                                </div>
                              )}
                              <hr className="border-hairline" />
                              <div className="flex items-center justify-between">
                                <div className="font-medium text-ink">Payload</div>
                                {payloadText && (
                                  <Button variant="secondary" size="sm" onClick={() => void copyPayload(d.payload)}>
                                    Copy payload
                                  </Button>
                                )}
                              </div>
                              {payloadText ? (
                                <pre className="type-mono overflow-x-auto rounded-xl bg-ink/[0.03] p-3 text-xs whitespace-pre-wrap dark:bg-polar-800">
                                  {payloadText}
                                </pre>
                              ) : (
                                <div className="text-sm text-ink-muted italic">No payload</div>
                              )}
                              {(d.response || d.last_error) && (
                                <>
                                  <hr className="border-hairline" />
                                  <div className="font-medium text-ink">Response</div>
                                  <pre className="type-mono overflow-x-auto rounded-xl bg-ink/[0.03] p-3 text-xs whitespace-pre-wrap dark:bg-polar-800">
                                    {d.response ?? d.last_error}
                                  </pre>
                                </>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
          {filtered.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-hairline px-4 py-3">
              <p className="type-body-sm text-ink-muted">
                Page {safePage + 1} of {pageCount}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={safePage === 0}
                  onClick={() => setPage(safePage - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={safePage >= pageCount - 1}
                  onClick={() => setPage(safePage + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <Sheet open={editOpen} onOpenChange={setEditOpen}>
        <SheetContent className="overflow-y-auto p-0 sm:max-w-[540px]">
          <SheetHeader className="px-8 pt-8 text-left">
            <SheetTitle className="text-xl font-normal">Edit webhook</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-y-8 p-8">
            <div className="flex flex-col gap-1">
              <div className="flex flex-row items-center justify-between">
                <Label>Name</Label>
              </div>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="My Webhook (optional)"
                className="h-11 rounded-xl"
              />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex flex-row items-center justify-between">
                <Label>URL</Label>
              </div>
              <Input
                value={editUrl}
                onChange={(e) => {
                  setEditUrl(e.target.value);
                  if (editUrlError) setEditUrlError(null);
                }}
                onBlur={(e) => setEditUrl(e.target.value.trim())}
                placeholder="https://..."
                inputMode="url"
                className={cn("h-11 rounded-xl", editUrlError && "border-red-500")}
              />
              {editUrlError && <p className="type-body-sm text-red-600">{editUrlError}</p>}
            </div>
            <TreeMultiSelect
              title="Events"
              options={eventOptions}
              value={editEvents}
              onChange={setEditEvents}
              separator="."
            />
            <Button type="button" disabled={saving} onClick={() => void saveEdit()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="rounded-2xl border border-hairline bg-white p-8 sm:max-w-[480px] dark:border-polar-800 dark:bg-polar-950">
          <DialogTitle className="text-xl font-medium text-ink">Reset webhook secret</DialogTitle>
          <p className="type-body-sm mt-2 text-ink-muted">
            This invalidates the current secret immediately — deliveries in flight will fail
            verification until you update your applier. Continue?
          </p>
          <div className="mt-4">
            <Label className="mb-2 block">New secret preview</Label>
            <p className="type-mono text-xs break-all text-ink-muted">
              A fresh secret is generated on confirm and shown once for copying.
            </p>
          </div>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={resetting} onClick={() => void resetSecret()}>
              {resetting ? "Resetting…" : "Reset Secret"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="rounded-2xl border border-hairline bg-white p-8 sm:max-w-[480px] dark:border-polar-800 dark:bg-polar-950">
          <DialogTitle className="text-xl font-medium text-ink">Delete webhook endpoint</DialogTitle>
          <p className="type-body-sm mt-2 text-ink-muted">
            This stops all deliveries to this URL and your mirror will go stale. This cannot
            be undone.
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={deleting} onClick={() => void destroy()}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
