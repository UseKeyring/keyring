"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useMyAccess } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { hashApiKey, newApiKey } from "@/lib/api-keys";
import type { MgmtStep } from "@/lib/supabase-management";
import { Button } from "@keyring/ui/components/button";
import { Input } from "@keyring/ui/components/input";
import { Label } from "@keyring/ui/components/label";
import { cn } from "@keyring/ui/lib/utils";

/*
 * Supabase connect wizard (migrations 0041 + 0044):
 *  1. One button — "Connect with Supabase" opens a CLI-style device login.
 *  2. Paste the verification code → the console lists your Supabase projects.
 *  3. Pick a project, then create a Keyring secret key (one click) or paste
 *     one manually — it wires the whole mirror (schema, triggers, exposed
 *     schemas, both edge functions, secrets, webhook endpoint).
 * Secrets (Supabase token, Keyring key) live in memory for this run only —
 * never stored, never logged.
 */

const START_URL = "/api/v1/integrations/supabase/start";
const PROJECTS_URL = "/api/v1/integrations/supabase/projects";
const VERIFY_URL = "/api/v1/integrations/supabase/verify";

type IntegrationRow = {
  id: string;
  project_ref: string;
  status: "pending" | "active" | "failed";
  step_log: MgmtStep[];
  updated_at: string;
};

type ProjectOption = { ref: string; name: string };

type Phase =
  | { name: "idle" }
  | { name: "started"; sessionId: string; loginUrl: string }
  | { name: "ready"; projects: ProjectOption[] }
  | { name: "running"; projectRef: string; startedAt: number }
  | { name: "done"; ok: boolean; steps: MgmtStep[]; projectRef: string };

type RouteData = {
  error?: string;
  session_id?: string;
  login_url?: string;
  projects?: ProjectOption[];
  supabase_token?: string;
  started?: boolean;
  project_ref?: string;
  ok?: boolean;
  steps?: MgmtStep[];
};

async function postJson(url: string, body: Record<string, unknown>, key?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as RouteData | null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data ?? {};
}

function StepsList({ steps }: { steps: MgmtStep[] }) {
  if (steps.length === 0) {
    return <p className="type-body-sm text-ink-muted">No steps reported yet.</p>;
  }
  return (
    <>
      {steps.map((s) => (
        <div key={s.step} className="flex items-start gap-3 rounded-2xl border border-hairline px-4 py-2">
          <span
            className={cn(
              "mt-1 inline-block h-2 w-2 shrink-0 rounded-full",
              s.ok ? "bg-emerald-500" : "bg-red-500",
            )}
          />
          <div className="min-w-0">
            <p className="type-mono text-sm">{s.step}</p>
            {s.detail && <p className="type-body-sm break-words text-ink-muted">{s.detail}</p>}
          </div>
        </div>
      ))}
    </>
  );
}

export function SupabaseConnectSection() {
  const { orgId } = useMyOrganization();
  const { user } = useAuth();
  const { can } = useMyAccess();
  const qc = useQueryClient();

  const [apiKey, setApiKey] = useState("");
  const [keyCreated, setKeyCreated] = useState(false);
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [busy, setBusy] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  // Short-lived Supabase token + project choice: component state only.
  const [supabaseToken, setSupabaseToken] = useState("");
  const [selectedRef, setSelectedRef] = useState("");

  const manageable = can("users.manage") || can("roles.manage");

  const integrations = useQuery({
    queryKey: ["supabase_integrations", orgId],
    enabled: !!orgId,
    placeholderData: (prev) => prev,
    // While a connect runs in the background (202 + after()), poll the row
    // so steps stream in live.
    refetchInterval: phase.name === "running" ? 3000 : false,
    queryFn: async (): Promise<IntegrationRow[]> => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("supabase_integrations")
        .select("id,project_ref,status,step_log,updated_at")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as Array<Omit<IntegrationRow, "step_log"> & { step_log: unknown }>).map(
        (row) => ({ ...row, step_log: Array.isArray(row.step_log) ? (row.step_log as MgmtStep[]) : [] }),
      );
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["supabase_integrations", orgId] });
    qc.invalidateQueries({ queryKey: ["webhook_endpoints", orgId] });
    qc.invalidateQueries({ queryKey: ["organization", orgId] });
  };

  const clearSecrets = () => {
    setApiKey("");
    setSupabaseToken("");
    setCode("");
    setKeyCreated(false);
  };

  // Step 1: one button — start the Supabase device login.
  const start = async () => {
    if (!user) {
      toast.error("Sign in required");
      return;
    }
    setBusy(true);
    try {
      const data = await postJson(START_URL, {});
      if (!data.session_id || !data.login_url) throw new Error("Unexpected start response");
      setPhase({ name: "started", sessionId: data.session_id, loginUrl: data.login_url });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start connect");
    } finally {
      setBusy(false);
    }
  };

  // Step 2: verify the code → list the user's Supabase projects.
  const listProjects = async () => {
    if (phase.name !== "started" || !code.trim()) {
      toast.error("Paste the verification code from Supabase");
      return;
    }
    const sessionId = phase.sessionId;
    setBusy(true);
    try {
      const data = await postJson(PROJECTS_URL, {
        session_id: sessionId,
        code: code.trim(),
      });
      if (!Array.isArray(data.projects) || typeof data.supabase_token !== "string") {
        throw new Error("Unexpected projects response");
      }
      setSupabaseToken(data.supabase_token);
      setCode("");
      setSelectedRef("");
      setPhase({ name: "ready", projects: data.projects as ProjectOption[] });
      if ((data.projects as ProjectOption[]).length === 0) {
        toast.error("No Supabase projects found on that account");
      }
    } catch (e) {
      // Session is single-use and already consumed — a retry needs a fresh login.
      toast.error(e instanceof Error ? e.message : "Verification failed — start a new connect");
      setPhase({ name: "idle" });
    } finally {
      setBusy(false);
    }
  };

  // Step 3a: one-click Keyring secret key with the integrations.write scope.
  const createKey = async () => {
    if (!user || !orgId || !selectedRef) return;
    setCreatingKey(true);
    try {
      const raw = newApiKey("secret");
      const { error } = await getSupabaseBrowserClient().from("api_keys").insert({
        name: `supabase-connect ${selectedRef}`,
        key_hash: await hashApiKey(raw),
        prefix: raw.slice(0, 12),
        key_type: "secret",
        scopes: ["integrations.write"],
        expires_at: null,
        organization_id: orgId,
        created_by: user.id,
      });
      if (error) throw error;
      setApiKey(raw);
      setKeyCreated(true);
      qc.invalidateQueries({ queryKey: ["api_keys", orgId] });
      toast.success("Key created — held for this run only");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create key");
    } finally {
      setCreatingKey(false);
    }
  };

  // Step 3b: wire the mirror on the selected project.
  const connect = async () => {
    if (phase.name !== "ready") return;
    if (!selectedRef) {
      toast.error("Select a Supabase project first");
      return;
    }
    if (!apiKey.trim()) {
      toast.error("Create a key or paste a secret key with the integrations.write scope");
      return;
    }
    if (!supabaseToken) {
      toast.error("Supabase session expired — start a new connect");
      setPhase({ name: "idle" });
      return;
    }
    const ref = selectedRef;
    const token = supabaseToken;
    const key = apiKey.trim();
    setBusy(true);
    try {
      const data = await postJson(
        VERIFY_URL,
        { project_ref: ref, supabase_token: token },
        key,
      );
      // Background path (202): orchestration continues server-side, the row
      // below streams progress. Inline fallback: final result already here.
      if (data.started === true) {
        clearSecrets();
        setPhase({ name: "running", projectRef: ref, startedAt: Date.now() });
        qc.invalidateQueries({ queryKey: ["supabase_integrations", orgId] });
        return;
      }
      const steps = Array.isArray(data.steps) ? (data.steps as MgmtStep[]) : [];
      const ok = data.ok === true;
      clearSecrets();
      setPhase({ name: "done", ok, steps, projectRef: ref });
      if (ok) toast.success("Supabase connected — mirror is live");
      else toast.error("Connect finished with failures — see steps below");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Connect failed");
    } finally {
      setBusy(false);
    }
  };

  // Background-run watcher: the verify route returns 202 fast and finishes
  // via after(); the integration row flips pending → active/failed with the
  // step log. 15-minute cap, then hand control back (the row keeps its state).
  useEffect(() => {
    if (phase.name !== "running") return;
    const row = (integrations.data ?? []).find((r) => r.project_ref === phase.projectRef);
    if (row?.status === "active" || row?.status === "failed") {
      const ok = row.status === "active";
      setPhase({ name: "done", ok, steps: row.step_log ?? [], projectRef: phase.projectRef });
      if (ok) toast.success("Supabase connected — mirror is live");
      else toast.error("Connect finished with failures — see steps below");
      qc.invalidateQueries({ queryKey: ["webhook_endpoints", orgId] });
      return;
    }
    if (Date.now() - phase.startedAt > 15 * 60 * 1000) {
      toast.error("Still no result after 15 minutes — check the row above, or retry");
      setPhase({ name: "idle" });
    }
  }, [phase, integrations.data, orgId, qc]);

  const disconnect = async (id: string, ref: string) => {
    try {
      const { error } = await getSupabaseBrowserClient()
        .from("supabase_integrations")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success(`Disconnected ${ref} (functions, secrets and keys stay — clean them up in Supabase/Keyring if needed)`);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not disconnect");
    }
  };

  const readyProjects = phase.name === "ready" ? phase.projects : [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="type-body-lg font-medium text-ink">Integrations</h2>
        <p className="type-body-sm mt-1 text-ink-muted">
          Connect external services. Supabase one-click wires the whole mirror:
          schema, triggers, exposed schemas, both edge functions, secrets, and
          the webhook endpoint. Uses a Supabase login link (same flow as the
          CLI) — no tokens pasted, nothing stored.
        </p>
      </div>

      {(integrations.data ?? []).length > 0 && (
        <div className="flex flex-col gap-2">
          {integrations.data!.map((i) => (
            <div
              key={i.id}
              className="flex items-center justify-between gap-4 rounded-2xl border border-hairline px-4 py-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className={cn(
                    "inline-block h-2 w-2 shrink-0 rounded-full",
                    i.status === "active"
                      ? "bg-emerald-500 ring-2 ring-emerald-100 dark:ring-emerald-900"
                      : i.status === "failed"
                        ? "bg-red-500 ring-2 ring-red-100 dark:ring-red-900"
                        : "bg-amber-500 ring-2 ring-amber-100 dark:ring-amber-900",
                  )}
                  title={i.status}
                />
                <span className="type-mono truncate text-sm">{i.project_ref}</span>
                <span className="type-body-sm shrink-0 text-ink-muted">{i.status}</span>
              </div>
              {manageable && (
                <Button variant="ghost" size="sm" onClick={() => void disconnect(i.id, i.project_ref)}>
                  Disconnect
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {manageable && (phase.name === "idle" || phase.name === "started" || phase.name === "ready") && (
        <div className="flex flex-col gap-y-4">
          {phase.name === "idle" && (
            <div>
              <Button disabled={busy} onClick={() => void start()}>
                {busy ? "Starting…" : "Connect with Supabase"}
              </Button>
            </div>
          )}
          {phase.name === "started" && (
            <>
              <div className="rounded-2xl border border-hairline p-4">
                <p className="type-body-sm text-ink">
                  Open this link, approve the login, then paste the verification code:
                </p>
                <a
                  href={phase.loginUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="type-mono mt-2 block break-all text-sm text-blue-400 underline"
                >
                  {phase.loginUrl}
                </a>
              </div>
              <div className="flex flex-col gap-1">
                <Label>Verification code</Label>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Paste code from Supabase"
                  className="h-11 rounded-xl font-mono sm:max-w-xs"
                />
              </div>
              <div>
                <Button disabled={busy} onClick={() => void listProjects()}>
                  {busy ? "Checking…" : "Continue"}
                </Button>
              </div>
            </>
          )}
          {phase.name === "ready" && (
            <>
              <div className="flex flex-col gap-1">
                <Label>Supabase project</Label>
                {readyProjects.length === 0 ? (
                  <p className="type-body-sm text-ink-muted">
                    No projects found — create one in Supabase first, then start a new connect.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {readyProjects.map((p) => (
                      <button
                        key={p.ref}
                        type="button"
                        onClick={() => setSelectedRef(p.ref)}
                        className={cn(
                          "flex items-center justify-between gap-4 rounded-2xl border px-4 py-3 text-left transition-colors",
                          selectedRef === p.ref
                            ? "border-ink bg-ink/5"
                            : "border-hairline hover:bg-ink/[0.02]",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm text-ink">{p.name}</span>
                          <span className="type-mono block truncate text-xs text-ink-muted">{p.ref}</span>
                        </span>
                        <span
                          className={cn(
                            "inline-block h-2 w-2 shrink-0 rounded-full",
                            selectedRef === p.ref ? "bg-emerald-500" : "bg-ink/20",
                          )}
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {selectedRef && (
                <>
                  <div className="flex flex-col gap-1">
                    <Label>Keyring secret key (integrations.write)</Label>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        disabled={creatingKey || keyCreated}
                        onClick={() => void createKey()}
                      >
                        {creatingKey ? "Creating…" : keyCreated ? "Key created" : "Create key"}
                      </Button>
                      <span className="type-body-sm text-ink-muted">or paste one manually:</span>
                    </div>
                    <Input
                      value={keyCreated ? "" : apiKey}
                      onChange={(e) => {
                        setApiKey(e.target.value);
                        setKeyCreated(false);
                      }}
                      placeholder={keyCreated ? "Created key held in memory for this run" : "kr_sk_live_…"}
                      type="password"
                      disabled={keyCreated}
                      className="h-11 rounded-xl font-mono sm:max-w-xs"
                    />
                    <p className="type-body-sm text-ink-muted">
                      {keyCreated
                        ? "Created key is held in memory for this run only, never stored."
                        : "Held in memory for this run only, never stored."}
                    </p>
                  </div>
                  <div>
                    <Button disabled={busy || !apiKey} onClick={() => void connect()}>
                      {busy ? "Connecting…" : "Wire mirror"}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {manageable && phase.name === "running" && (
        <div className="flex flex-col gap-2">
          <p className="type-body-sm text-ink">
            Wiring the mirror on {phase.projectRef}… this takes a couple of minutes.
            You can leave this page — progress is saved on the integration row above.
          </p>
          <StepsList
            steps={
              (integrations.data ?? []).find((r) => r.project_ref === phase.projectRef)?.step_log ?? []
            }
          />
        </div>
      )}

      {phase.name === "done" && (
        <div className="flex flex-col gap-2">
          <p className={cn("type-body-sm", phase.ok ? "text-ink" : "text-red-600 dark:text-red-300")}>
            {phase.ok
              ? `Connected ${phase.projectRef} — test with a throwaway signup.`
              : `Connect to ${phase.projectRef} finished with failures:`}
          </p>
          <StepsList steps={phase.steps} />
          <div>
            <Button variant="secondary" onClick={() => setPhase({ name: "idle" })}>
              Connect another project
            </Button>
          </div>
        </div>
      )}

      {!manageable && (
        <p className="type-mono text-ink-muted">
          Connecting Supabase requires users.manage or roles.manage.
        </p>
      )}
    </div>
  );
}
