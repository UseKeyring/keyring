"use client";

import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseBrowserClient } from "@/integrations/supabase/client";
import { useMyOrganization } from "@/hooks/useOrganization";

export type CheckEvent = {
  id: string;
  organization_id: string;
  subject_id: string | null;
  subject_external_id: string;
  permission_id: string | null;
  permission_slug: string;
  matched_role_slugs: string[];
  allowed: boolean;
  api_key_id: string | null;
  event_type: string;
  context: Record<string, unknown>;
  created_at: string;
};

export type TelemetryRange = "7d" | "30d" | "90d";

export function rangeStart(range: TelemetryRange): string {
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

export function useCheckEvents(range: TelemetryRange, limit = 2000) {
  const { orgId } = useMyOrganization();
  const from = rangeStart(range);
  return useQuery({
    queryKey: ["check_events", orgId, range, limit],
    enabled: !!orgId,
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<CheckEvent[]> => {
      const { data, error } = await getSupabaseBrowserClient()
        .from("check_events")
        .select("*")
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as unknown as CheckEvent[];
    },
  });
}

export function usePurgeTelemetry() {
  const qc = useQueryClient();
  return async (orgId: string, days = 90) => {
    const { data, error } = await getSupabaseBrowserClient().rpc("purge_check_events", {
      _org: orgId,
      _days: days,
    });
    if (error) throw error;
    qc.invalidateQueries({ queryKey: ["check_events"] });
    return data as number;
  };
}

export type TelemetrySummary = {
  total: number;
  allowed: number;
  denied: number;
  allowRate: number;
  activeSubjects: number;
  topAction: string | null;
  topRole: string | null;
  peakHour: number | null;
};

export function summarizeEvents(events: CheckEvent[]): TelemetrySummary {
  const total = events.length;
  const allowed = events.filter((e) => e.allowed).length;
  const subjects = new Set(events.map((e) => e.subject_external_id));
  const actionCounts = new Map<string, number>();
  const roleCounts = new Map<string, number>();
  const hourCounts = new Array<number>(24).fill(0);
  for (const e of events) {
    actionCounts.set(e.permission_slug, (actionCounts.get(e.permission_slug) ?? 0) + 1);
    for (const r of e.matched_role_slugs ?? []) {
      roleCounts.set(r, (roleCounts.get(r) ?? 0) + 1);
    }
    const h = new Date(e.created_at).getHours();
    hourCounts[h] = (hourCounts[h] ?? 0) + 1;
  }
  const top = (m: Map<string, number>) => {
    let best: string | null = null;
    let n = 0;
    for (const [k, v] of m) if (v > n) { n = v; best = k; }
    return best;
  };
  let peakHour: number | null = null;
  let peakN = 0;
  hourCounts.forEach((n, h) => { if (n > peakN) { peakN = n; peakHour = h; } });
  return {
    total,
    allowed,
    denied: total - allowed,
    allowRate: total === 0 ? 0 : allowed / total,
    activeSubjects: subjects.size,
    topAction: top(actionCounts),
    topRole: top(roleCounts),
    peakHour,
  };
}

export function useTelemetrySummary(events: CheckEvent[] | undefined): TelemetrySummary {
  return useMemo(() => summarizeEvents(events ?? []), [events]);
}
