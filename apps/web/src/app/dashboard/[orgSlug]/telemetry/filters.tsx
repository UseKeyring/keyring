"use client";

import { useState } from "react";
import { SolarIcon } from "@keyring/ui/components/solar-icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@keyring/ui/components/popover";
import { cn } from "@keyring/ui/lib/utils";
import type { TelemetryRange } from "@/hooks/useTelemetry";

export type AllowedFilter = "all" | "allowed" | "denied";

const RANGES: { value: TelemetryRange; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

const RESULTS: { value: AllowedFilter; label: string }[] = [
  { value: "all", label: "All results" },
  { value: "allowed", label: "Allowed" },
  { value: "denied", label: "Denied" },
];

function OptionRow({
  label,
  mono,
  selected,
  onSelect,
}: {
  label: string;
  mono?: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
        selected ? "text-ink" : "text-ink-muted hover:text-ink",
        selected && "bg-pillar dark:bg-polar-800",
      )}
    >
      <span className={cn("type-body-sm min-w-0 flex-1 truncate", mono && "type-mono")}>
        {label}
      </span>
      {selected && <SolarIcon name="check" className="h-4 w-4 shrink-0" />}
    </button>
  );
}

/*
 * Polar-style Customize pill: one sliders button opening a single popover
 * with every telemetry filter grouped inside (range / action / result).
 */
export function TelemetryFilters({
  range,
  setRange,
  permission,
  setPermission,
  allowed,
  setAllowed,
  permissions,
}: {
  range: TelemetryRange;
  setRange: (r: TelemetryRange) => void;
  permission: string;
  setPermission: (p: string) => void;
  allowed: AllowedFilter;
  setAllowed: (a: AllowedFilter) => void;
  permissions: string[];
}) {
  const [open, setOpen] = useState(false);
  const activeCount =
    (range !== "30d" ? 1 : 0) + (permission !== "all" ? 1 : 0) + (allowed !== "all" ? 1 : 0);
  const isDefault = activeCount === 0;

  const reset = () => {
    setRange("30d");
    setPermission("all");
    setAllowed("all");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-full border border-transparent bg-ink px-4 py-2 text-white transition-opacity hover:opacity-90 dark:border-polar-700 dark:bg-polar-800 dark:text-white"
        >
          <SolarIcon name="customize" className="h-4 w-4" />
          <span className="type-body-sm font-medium">Customize</span>
          {activeCount > 0 && (
            <span className="type-mono flex h-5 min-w-5 items-center justify-center rounded-full bg-white/20 px-1.5 text-[11px]">
              {activeCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div className="px-2.5 pt-2 pb-1.5">
          <span className="type-mono text-ink-muted">Date range</span>
        </div>
        {RANGES.map((r) => (
          <OptionRow
            key={r.value}
            label={r.label}
            selected={range === r.value}
            onSelect={() => setRange(r.value)}
          />
        ))}

        <div className="mx-2.5 my-2 border-t border-hairline" />

        <div className="px-2.5 pt-1 pb-1.5">
          <span className="type-mono text-ink-muted">Action</span>
        </div>
        <div className="max-h-48 overflow-y-auto">
          <OptionRow
            label="All actions"
            selected={permission === "all"}
            onSelect={() => setPermission("all")}
          />
          {permissions.map((p) => (
            <OptionRow
              key={p}
              label={p}
              mono
              selected={permission === p}
              onSelect={() => setPermission(p)}
            />
          ))}
        </div>

        <div className="mx-2.5 my-2 border-t border-hairline" />

        <div className="px-2.5 pt-1 pb-1.5">
          <span className="type-mono text-ink-muted">Result</span>
        </div>
        {RESULTS.map((r) => (
          <OptionRow
            key={r.value}
            label={r.label}
            selected={allowed === r.value}
            onSelect={() => setAllowed(r.value)}
          />
        ))}

        {!isDefault && (
          <>
            <div className="mx-2.5 my-2 border-t border-hairline" />
            <button
              type="button"
              onClick={reset}
              className="type-body-sm w-full rounded-lg px-2.5 py-2 text-left text-ink-muted transition-colors hover:text-ink"
            >
              Reset filters
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
