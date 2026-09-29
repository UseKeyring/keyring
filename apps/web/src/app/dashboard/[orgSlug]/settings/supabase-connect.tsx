"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { useMyAccess } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { Button } from "@keyring/ui/components/button";
import { Input } from "@keyring/ui/components/input";
import { Label } from "@keyring/ui/components/label";
import { cn } from "@keyring/ui/lib/utils";
import type { MgmtStep } from "@/lib/supabase-management";

/*
 * One-click Supabase connect (migration 0041): CLI-style device login +
 * full mirror orchestration, driven by POST /api/v1/integrations/supabase/*.
 * Needs a Keyring SECRET key with the integrations.write scope — pasted here,
 * held in memory for this run only, never stored. The Supabase user token
 * from the device flow is likewise never persisted (session-only by design).
 */

const START_URL = "/api/v1/integrations/supabase/start";
const VERIFY_URL = "/api/v1/integrations/supabase/verify";

type IntegrationRow = {
  id: string;
  project_ref: string;
  status: "pending" | "active" | "failed";
  updated_at: string;
};

type Phase =
  | { name: "idle" }
  | { name: "started"; sessionId: string; loginUrl: string }
  | { name: "verifying" }
  | { name: "done"; ok: boolean; steps: MgmtStep[]; projectRef: string };

async function callRoute(url: string, key: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as {
    error?: string;
    session_id?: string;
    login_url?: string;
    ok?: boolean;
    steps?: MgmtStep[];
  } | null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data ?? {};
}

export function SupabaseConnectSection() {
  const { orgId } = useMyOrganization();
  const { user } = useAuth();
  const { can } = useMyAccess();
  const qc = useQueryClient();

  const [apiKey, setApiKey] = useState("");
  const [projectRef, setProjectRef] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [busy, setBusy] = useState(false);

  const manageable = can("users.manage") || can("roles.manage");

  const integrations = useQuery({
    queryKey: ["supabase_integrations", orgId],
    enabled: !!orgId,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<IntegrationRow[]> => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("supabase_integrations")
        .select("id,project_ref,status,updated_at")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as IntegrationRow[];
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["supabase_integrations", orgId] });
    qc.invalidateQueries({ queryKey: ["webhook_endpoints", orgId] });
    qc.invalidateQueries({ queryKey: ["organization", orgId] });
  };

  const start = async () => {
    if (!user || !/^[a-z]{20}$/.test(projectRef.trim())) {
      toast.error("Enter your Supabase project ref (20 lowercase letters)");
      return;
    }
    if (!apiKey.trim()) {
      toast.error("Paste a secret key with the integrations.write scope");
      return;
    }
    setBusy(true);
    try {
      const data = await callRoute(START_URL, apiKey.trim(), {});
      if (!data.session_id || !data.login_url) throw new Error("Unexpected start response");
      setPhase({ name: "started", sessionId: data.session_id, loginUrl: data.login_url });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start connect");
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (phase.name !== "started" || !code.trim()) {
      toast.error("Paste the verification code from Supabase");
      return;
    }
    setPhase({ name: "verifying" });
    try {
      const data = await callRoute(VERIFY_URL, apiKey.trim(), {
        session_id: phase.sessionId,
        project_ref: projectRef.trim(),
        code: code.trim(),
      });
      const steps = data.steps ?? [];
      const ok = data.ok === true;
      setPhase({ name: "done", ok, steps, projectRef: projectRef.trim() });
      setApiKey("");
      setCode("");
      if (ok) toast.success("Supabase connected — mirror is live");
      else toast.error("Connect finished with failures — see steps below");
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification failed");
      setPhase({ name: "idle" });
    }
  };

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

  return (
    <div className="space-y-6">
      <div>
        <h2 className="type-body-lg font-medium text-ink">Supabase connect</h2>
        <p className="type-body-sm mt-1 text-ink-muted">
          One click wires the whole mirror: schema, triggers, exposed schemas, both edge
          functions, secrets, and the webhook endpoint. Uses a Supabase login link (same
          flow as the CLI) — no tokens pasted, nothing stored.
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

      {manageable && phase.name !== "done" && (
        <div className="flex flex-col gap-y-4">
          {phase.name === "idle" && (
            <>
              <div className="flex flex-col gap-1">
                <Label>Project ref</Label>
                <Input
                  value={projectRef}
                  onChange={(e) => setProjectRef(e.target.value.trim())}
                  placeholder="abcdefghijklmnopqrst"
                  className="h-11 rounded-xl font-mono sm:max-w-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Keyring secret key (integrations.write)</Label>
                <Input
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="kr_sk_live_…"
                  type="password"
                  className="h-11 rounded-xl font-mono sm:max-w-xs"
                />
                <p className="type-body-sm text-ink-muted">
                  Create one in Settings → API keys, integrations.write scope. Held in
                  memory for this run only, never stored.
                </p>
              </div>
              <div>
                <Button disabled={busy} onClick={() => void start()}>
                  {busy ? "Starting…" : "Connect with Supabase"}
                </Button>
              </div>
            </>
          )}
          {(phase.name === "started" || phase.name === "verifying") && (
            <>
              <div className="rounded-2xl border border-hairline p-4">
                <p className="type-body-sm text-ink">
                  Open this link, approve the login, then paste the verification code:
                </p>
                <a
                  href={phase.name === "started" ? phase.loginUrl : "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="type-mono mt-2 block break-all text-sm text-blue-400 underline"
                >
                  {phase.name === "started" ? phase.loginUrl : "…"}
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
                <Button disabled={phase.name === "verifying"} onClick={() => void verify()}>
                  {phase.name === "verifying" ? "Connecting — wiring the mirror…" : "Verify & connect"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {phase.name === "done" && (
        <div className="flex flex-col gap-2">
          <p className={cn("type-body-sm", phase.ok ? "text-ink" : "text-red-600 dark:text-red-300")}>
            {phase.ok
              ? `Connected ${phase.projectRef} — test with a throwaway signup.`
              : `Connect to ${phase.projectRef} finished with failures:`}
          </p>
          {phase.steps.map((s) => (
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
