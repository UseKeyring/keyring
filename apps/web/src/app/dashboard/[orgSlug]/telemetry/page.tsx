"use client";

import { useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { useMyAccess } from "@/hooks/useRbac";
import { useMyOrganization } from "@/hooks/useOrganization";
import {
  rangeStart,
  useCheckEvents,
  useTelemetrySummary,
  type CheckEvent,
  type TelemetryRange,
} from "@/hooks/useTelemetry";
import { OverviewStats } from "@/app/dashboard/console-ui";
import { useDashboardBase } from "@/app/dashboard/dashboard-chrome";
import { NoAccess } from "@keyring/ui/components/no-access";
import {
  StatCardsSkeleton,
  PanelSkeleton,
  TableSkeleton,
} from "@keyring/ui/components/skeletons";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@keyring/ui/components/chart";
import { Input } from "@keyring/ui/components/input";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { TelemetryFilters, type AllowedFilter } from "./filters";

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shortDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function TopBar({ label, count, max }: { label: string; count: number; max: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="type-mono w-40 truncate text-ink" title={label}>
        {label}
      </span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-hairline">
        <div
          className="h-full rounded-full bg-ink"
          style={{ width: `${max === 0 ? 0 : Math.round((count / max) * 100)}%` }}
        />
      </div>
      <span className="type-mono w-12 text-right text-ink-muted tabular-nums">{count}</span>
    </div>
  );
}

// Polar-style bar: zero values still render a 4px stub so sparse days stay visible.
function MinHeightBar(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string;
}) {
  const { x = 0, y = 0, width = 0, height = 0, fill } = props;
  const minHeight = 4;
  const actualHeight = height === 0 ? minHeight : height;
  const actualY = height === 0 ? y - minHeight : y;
  return (
    <rect
      x={x}
      y={actualY}
      width={width}
      height={actualHeight}
      fill={fill}
      rx={1}
      ry={1}
    />
  );
}

const ALLOWED_COLOR = "#2563eb";

export default function TelemetryPage() {
  const { can, loading: accessLoading } = useMyAccess();
  const { org } = useMyOrganization();
  const base = useDashboardBase();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const deniedColor = isDark ? "#383942" : "#ccc";
  const gridColor = isDark ? "#222225" : "#e5e7eb";
  const [range, setRange] = useState<TelemetryRange>("30d");
  const [permission, setPermission] = useState<string>("all");
  const [allowed, setAllowed] = useState<AllowedFilter>("all");
  const [query, setQuery] = useState("");
  const [activeSeries, setActiveSeries] = useState<string | null>(null);

  const eventsQuery = useCheckEvents(range);
  const events = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data]);

  const permissions = useMemo(
    () => [...new Set(events.map((e) => e.permission_slug))].sort(),
    [events],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((e) => {
      if (permission !== "all" && e.permission_slug !== permission) return false;
      if (allowed === "allowed" && !e.allowed) return false;
      if (allowed === "denied" && e.allowed) return false;
      if (
        q &&
        !e.subject_external_id.toLowerCase().includes(q) &&
        !e.permission_slug.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [events, permission, allowed, query]);

  const summary = useTelemetrySummary(filtered);

  const daily = useMemo(() => {
    const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
    const buckets = new Map<string, { allowed: number; denied: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000);
      const key = dayKey(d.toISOString());
      buckets.set(key, { allowed: 0, denied: 0 });
    }
    for (const e of filtered) {
      const b = buckets.get(dayKey(e.created_at));
      if (!b) continue;
      if (e.allowed) b.allowed += 1;
      else b.denied += 1;
    }
    return [...buckets.entries()].map(([day, v]) => ({
      day: shortDay(day),
      allowed: v.allowed,
      denied: v.denied,
      total: v.allowed + v.denied,
    }));
  }, [filtered, range]);

  const topActions = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of filtered) m.set(e.permission_slug, (m.get(e.permission_slug) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [filtered]);

  const topRoles = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of filtered) {
      for (const r of e.matched_role_slugs ?? []) m.set(r, (m.get(r) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [filtered]);

  const topSubjects = useMemo(() => {
    const m = new Map<string, { total: number; allowed: number }>();
    for (const e of filtered) {
      const cur = m.get(e.subject_external_id) ?? { total: 0, allowed: 0 };
      cur.total += 1;
      if (e.allowed) cur.allowed += 1;
      m.set(e.subject_external_id, cur);
    }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 8);
  }, [filtered]);

  const hourly = useMemo(() => {
    const counts = new Array<number>(24).fill(0);
    for (const e of filtered) {
      const h = new Date(e.created_at).getHours();
      counts[h] = (counts[h] ?? 0) + 1;
    }
    return counts.map((count, hour) => ({ hour, count }));
  }, [filtered]);

  const maxDaily = useMemo(
    () => Math.max(1, ...daily.map((d) => d.total)),
    [daily],
  );

  const toggleSeries = (key: string) =>
    setActiveSeries((cur) => (cur === key ? null : key));

  if (accessLoading) {
    return (
      <div className="space-y-6">
        <StatCardsSkeleton count={4} />
        <PanelSkeleton />
        <TableSkeleton rows={8} columns={4} />
      </div>
    );
  }

  if (!can("telemetry.read")) {
    return <NoAccess title="Telemetry" action="telemetry.read" noun="usage data" />;
  }

  const loading = eventsQuery.isLoading;
  const stats = [
    { label: "Checks", value: summary.total, to: `${base}/telemetry`, readable: true },
    {
      label: "Allow rate",
      value: Math.round(summary.allowRate * 100),
      to: `${base}/telemetry`,
      readable: true,
    },
    { label: "Active subjects", value: summary.activeSubjects, to: `${base}/users`, readable: can("users.read") },
    { label: "Denied", value: summary.denied, to: `${base}/telemetry`, readable: true },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Telemetry</h1>
          <p className="type-body-sm mt-1 text-ink-muted">
            Every <span className="type-mono">check</span> is logged automatically with the
            roles that granted it — plus your manual events. Raw rows are kept 90 days.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <TelemetryFilters
            range={range}
            setRange={setRange}
            permission={permission}
            setPermission={setPermission}
            allowed={allowed}
            setAllowed={setAllowed}
            permissions={permissions}
          />
        </div>
      </div>

      {loading ? (
        <>
          <StatCardsSkeleton count={4} />
          <PanelSkeleton />
          <TableSkeleton rows={8} columns={4} />
        </>
      ) : (
        <>
          <OverviewStats stats={stats} />
          {summary.topAction && (
            <p className="type-mono text-ink-muted">
              Top action: {summary.topAction}
              {summary.topRole ? ` · Top role: ${summary.topRole}` : " · No granting role yet"}
              {summary.peakHour !== null ? ` · Peak hour: ${summary.peakHour}:00` : ""}
            </p>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="min-w-0 rounded-2xl border border-hairline bg-pillar p-6 dark:border-transparent dark:bg-polar-800">
              <div className="flex items-center justify-between">
                <div className="type-body-sm text-ink">Checks over time</div>
                <div className="flex items-center gap-4">
                  {(
                    [
                      { key: "allowed", label: "Allowed", color: ALLOWED_COLOR },
                      { key: "denied", label: "Denied", color: deniedColor },
                    ] as const
                  ).map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => toggleSeries(s.key)}
                      className="flex items-center gap-1.5 whitespace-nowrap transition-opacity"
                      style={{ opacity: activeSeries === null || activeSeries === s.key ? 1 : 0.3 }}
                    >
                      <div
                        className="h-2 w-2 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: s.color }}
                      />
                      <span className="type-body-sm text-ink-muted">{s.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <ChartContainer
                config={{
                  allowed: { label: "Allowed", color: ALLOWED_COLOR },
                  denied: { label: "Denied", color: deniedColor },
                }}
                style={{ height: 280, width: "100%" }}
                className="mt-4 w-full"
              >
                <BarChart
                  accessibilityLayer
                  data={daily}
                  margin={{ left: 8, right: 8, top: 24 }}
                  barCategoryGap="25%"
                >
                  <CartesianGrid
                    vertical={false}
                    stroke={gridColor}
                    strokeDasharray="3 3"
                  />
                  <XAxis
                    dataKey="day"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={32}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickMargin={4}
                    width={32}
                    allowDecimals={false}
                    domain={[0, maxDaily]}
                  />
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        className="text-black dark:text-white"
                        indicator="dot"
                      />
                    }
                  />
                  <Bar
                    dataKey="allowed"
                    stackId="checks"
                    fill="var(--color-allowed)"
                    shape={<MinHeightBar />}
                    opacity={activeSeries === null || activeSeries === "allowed" ? 1 : 0.3}
                  />
                  <Bar
                    dataKey="denied"
                    stackId="checks"
                    fill="var(--color-denied)"
                    shape={<MinHeightBar />}
                    opacity={activeSeries === null || activeSeries === "denied" ? 1 : 0.3}
                  />
                </BarChart>
              </ChartContainer>
              <p className="type-body-sm mt-3 text-ink-muted">
                {summary.total} checks · {Math.round(summary.allowRate * 100)}% allowed
                since {new Date(rangeStart(range)).toLocaleDateString()}.
              </p>
            </div>

            <div className="min-w-0 rounded-2xl border border-hairline bg-pillar p-6 dark:border-transparent dark:bg-polar-800">
              <div className="type-body-sm text-ink">Most active hours (local)</div>
              <ChartContainer
                config={{ count: { label: "Checks", color: ALLOWED_COLOR } }}
                style={{ height: 280, width: "100%" }}
                className="mt-4 w-full"
              >
                <BarChart
                  accessibilityLayer
                  data={hourly}
                  margin={{ left: 8, right: 8, top: 24 }}
                  barCategoryGap="25%"
                >
                  <CartesianGrid
                    horizontal={false}
                    vertical={true}
                    stroke={gridColor}
                    strokeDasharray="6 6"
                    syncWithTicks={true}
                  />
                  <XAxis
                    dataKey="hour"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    ticks={[0, 6, 12, 18]}
                    tickFormatter={(v: number) => `${v}h`}
                  />
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        className="text-black dark:text-white"
                        indicator="dot"
                        labelFormatter={(v) => `${v}:00 local`}
                      />
                    }
                  />
                  <Bar
                    dataKey="count"
                    fill="var(--color-count)"
                    shape={<MinHeightBar />}
                  />
                </BarChart>
              </ChartContainer>
              <p className="type-body-sm mt-3 text-ink-muted">
                {summary.peakHour !== null
                  ? `Peak at ${summary.peakHour}:00 local.`
                  : "No events in range."}{" "}
                Since {new Date(rangeStart(range)).toLocaleDateString()}.
              </p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border border-hairline bg-pillar p-6 dark:border-transparent dark:bg-polar-800">
              <div className="type-body-sm text-ink">Most used actions</div>
              <div className="mt-4 space-y-3">
                {topActions.length === 0 && (
                  <p className="type-body-sm text-ink-muted">No checks yet.</p>
                )}
                {topActions.map(([slug, n]) => (
                  <TopBar key={slug} label={slug} count={n} max={topActions[0]![1]} />
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-hairline bg-pillar p-6 dark:border-transparent dark:bg-polar-800">
              <div className="type-body-sm text-ink">Most used roles</div>
              <div className="mt-4 space-y-3">
                {topRoles.length === 0 && (
                  <p className="type-body-sm text-ink-muted">
                    No granting role recorded — checks were denied or roles changed.
                  </p>
                )}
                {topRoles.map(([slug, n]) => (
                  <TopBar key={slug} label={slug} count={n} max={topRoles[0]![1]} />
                ))}
              </div>
            </div>
            <div className="rounded-2xl border border-hairline bg-pillar p-6 dark:border-transparent dark:bg-polar-800">
              <div className="type-body-sm text-ink">Most active subjects</div>
              <div className="mt-4 space-y-3">
                {topSubjects.length === 0 && (
                  <p className="type-body-sm text-ink-muted">No subjects yet.</p>
                )}
                {topSubjects.map(([sub, v]) => (
                  <div key={sub} className="flex items-center justify-between gap-3">
                    <span className="type-mono min-w-0 flex-1 truncate text-ink" title={sub}>
                      {org.data?.telemetry_subject_mode === "hashed" ? `${sub.slice(0, 12)}…` : sub}
                    </span>
                    <span className="type-mono text-ink-muted tabular-nums">
                      {v.total} · {Math.round((v.allowed / v.total) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-hairline bg-canvas">
            <div className="flex flex-col gap-3 border-b border-hairline px-6 py-4 md:flex-row md:items-center md:justify-between md:px-8">
              <div className="type-body-sm text-ink">
                Recent events{" "}
                <span className="text-ink-muted">({filtered.length} in range)</span>
              </div>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by subject or action…"
                className="md:w-64"
              />
            </div>
            <div className="overflow-x-auto">
              <table className="type-body-sm w-full min-w-[760px]">
                <thead>
                  <tr className="type-mono border-b border-hairline text-left text-ink-muted">
                    <th className="px-6 py-4 font-normal md:px-8">When</th>
                    <th className="px-6 py-4 font-normal md:px-8">Subject</th>
                    <th className="px-6 py-4 font-normal md:px-8">Action</th>
                    <th className="px-6 py-4 font-normal md:px-8">Roles</th>
                    <th className="px-6 py-4 font-normal md:px-8">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 50).map((row: CheckEvent) => (
                    <tr key={row.id} className="border-b border-hairline last:border-0">
                      <td className="type-mono px-6 py-4 whitespace-nowrap text-ink-muted md:px-8">
                        {new Date(row.created_at).toLocaleString()}
                      </td>
                      <td className="type-mono px-6 py-4 text-ink md:px-8">
                        {org.data?.telemetry_subject_mode === "hashed"
                          ? `${row.subject_external_id.slice(0, 12)}…`
                          : row.subject_external_id}
                        {row.event_type === "custom" && (
                          <span className="ml-2 rounded-full bg-ink/[0.04] px-2 py-0.5 text-[11px] text-ink-muted">
                            custom
                          </span>
                        )}
                      </td>
                      <td className="type-mono px-6 py-4 text-ink md:px-8">
                        {row.permission_slug}
                      </td>
                      <td className="px-6 py-4 text-ink-muted md:px-8">
                        {(row.matched_role_slugs ?? []).join(", ") || "—"}
                      </td>
                      <td className="px-6 py-4 md:px-8">
                        <span
                          className={
                            row.allowed
                              ? "text-emerald-600 dark:text-emerald-400"
                              : "text-red-500"
                          }
                        >
                          {row.allowed ? "allowed" : "denied"}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td className="px-6 py-6 text-ink-muted md:px-8" colSpan={5}>
                        No events yet — call{" "}
                        <span className="type-mono">check()</span> with an action or{" "}
                        <span className="type-mono">track()</span> from the SDK.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
