"use client";

import { cn } from "@keyring/ui/lib/utils";

/*
 * Page-shaped skeleton loaders — ported from polar-web patterns:
 * - `ToplistSkeleton` (clients/apps/web/src/components/Shared/Toplist.tsx):
 *   avatar + two-line label + right-aligned value, wrapped in one
 *   `animate-pulse` container so the row shimmers as a unit.
 * - `SkeletonGrid` (settings/migrations/MigrationsPage.tsx): bordered card
 *   with icon block + `Text loading` placeholders.
 * - Chart/widget blocks (CustomerGrowthChart, CompassWidget, Timeline):
 *   a single `animate-pulse` wrapper around a `background-card` block.
 *
  * Dark-console mapping: polar `bg-gray-100 dark:bg-polar-700` pulse blocks
  * on `bg-pillar dark:bg-polar-800` cards inside a
  * `bg-white dark:bg-polar-900` main, hairline borders.
 */

function Pulse({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <div className={cn("animate-pulse", className)} aria-hidden>{children}</div>;
}

function Block({ className }: { className?: string }) {
  return <div aria-hidden className={cn("bg-gray-100 dark:bg-polar-700", className)} />;
}

/** Overview stat cards — matches the 4-up grid on /dashboard. */
export function StatCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-2xl border border-hairline bg-pillar p-6 dark:border-transparent dark:bg-polar-800">
          <Pulse className="flex flex-col gap-3">
            <Block className="h-3.5 w-16 rounded-sm" />
            <Block className="h-12 w-20 rounded-sm" />
          </Pulse>
        </div>
      ))}
    </div>
  );
}

/** Role matrix / wide panel block — matches the overview matrix card. */
export function PanelSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-2xl border border-hairline bg-pillar p-6 md:p-8 dark:border-transparent dark:bg-polar-800">
      <Pulse className="flex flex-col gap-4">
        <Block className="h-3.5 w-24 rounded-sm" />
        <div className="flex flex-col gap-3 pt-2">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 border-t border-hairline pt-3">
              <Block className="h-3.5 flex-1 rounded-sm" />
              <Block className="h-3.5 w-8 rounded-sm" />
              <Block className="h-3.5 w-8 rounded-sm" />
              <Block className="hidden h-3.5 w-8 rounded-sm sm:block" />
            </div>
          ))}
        </div>
      </Pulse>
    </div>
  );
}

/**
 * Toplist rows — direct port of Polar's `ToplistSkeleton`: 32px round
 * avatar, two-line label (40%/55%), right-aligned value (56/40px).
 */
export function ToplistSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="-mx-3 animate-pulse" aria-hidden>
      <div className="flex flex-col">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-3">
            <div className="h-8 w-8 shrink-0 rounded-full bg-gray-100 dark:bg-polar-700" />
            <div className="flex flex-1 flex-col gap-2">
              <div className="h-3.5 w-[40%] rounded-sm bg-gray-100 dark:bg-polar-700" />
              <div className="h-2.5 w-[55%] rounded-sm bg-gray-100 dark:bg-polar-700" />
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="h-3.5 w-14 rounded-sm bg-gray-100 dark:bg-polar-700" />
              <div className="h-2.5 w-10 rounded-sm bg-gray-100 dark:bg-polar-700" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Actions-style list group — eyebrow label + small List rows. */
export function ListSkeleton({ groups = 2, rows = 4 }: { groups?: number; rows?: number }) {
  return (
    <div className="space-y-6" aria-hidden>
      {Array.from({ length: groups }).map((_, g) => (
        <div key={g}>
          <Pulse>
            <Block className="mb-2 ml-2 h-3 w-20 rounded-sm" />
          </Pulse>
          <div className="flex flex-col divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline dark:divide-polar-700 dark:border-polar-700">
            {Array.from({ length: rows }).map((_, i) => (
              <div key={i} className="flex animate-pulse flex-row items-center justify-between gap-x-6 px-4 py-2">
                <div className="flex min-w-0 grow flex-col gap-2">
                  <div className="h-3.5 w-2/5 rounded-sm bg-gray-100 dark:bg-polar-700" />
                  <div className="h-3 w-3/5 rounded-sm bg-gray-100 dark:bg-polar-700" />
                </div>
                <div className="h-7 w-16 shrink-0 rounded-full bg-gray-100 dark:bg-polar-700" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Roles-style card grid — port of Polar's `SkeletonGrid` migration cards. */
export function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2" aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-2xl border border-hairline bg-pillar p-6 md:p-8 dark:border-transparent dark:bg-polar-800"
        >
          <Pulse className="flex flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Block className="h-5 w-32 rounded-sm" />
                <Block className="h-3 w-24 rounded-sm" />
              </div>
              <Block className="h-7 w-16 shrink-0 rounded-full" />
            </div>
            <div className="flex flex-col gap-3 border-t border-hairline pt-6">
              {Array.from({ length: 3 }).map((_, j) => (
                <div key={j} className="flex items-center gap-3">
                  <Block className="h-4 w-4 rounded-sm" />
                  <Block className="h-3.5 flex-1 rounded-sm" />
                </div>
              ))}
            </div>
          </Pulse>
        </div>
      ))}
    </div>
  );
}

/** Table rows — for Users / Members / Activity tables. */
export function TableSkeleton({
  rows = 6,
  columns = 3,
  avatar = false,
}: {
  rows?: number;
  columns?: number;
  avatar?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-hairline bg-canvas" aria-hidden>
      <div className="flex animate-pulse flex-col">
        <div className="flex gap-4 border-b border-hairline px-6 py-4 md:px-8">
          {Array.from({ length: columns }).map((_, i) => (
            <div
              key={i}
              className="h-3 rounded-sm bg-gray-100 dark:bg-polar-700"
              style={{ width: `${Math.max(48, 140 - i * 28)}px` }}
            />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, r) => (
          <div
            key={r}
            className="flex items-center gap-4 border-b border-hairline px-6 py-4 last:border-0 md:px-8"
          >
            {avatar && (
              <div className="h-8 w-8 shrink-0 rounded-full bg-gray-100 dark:bg-polar-700" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div
                className="h-3.5 rounded-sm bg-gray-100 dark:bg-polar-700"
                style={{ width: `${[38, 52, 31, 46, 40, 56, 35, 48][r % 8]}%` }}
              />
              <div className="h-2.5 w-1/4 rounded-sm bg-gray-100 dark:bg-polar-700" />
            </div>
            {Array.from({ length: Math.max(columns - 1, 1) }).map((_, c) => (
              <div
                key={c}
                className="hidden h-3.5 w-16 shrink-0 rounded-sm bg-gray-100 sm:block dark:bg-polar-700"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Settings form — identifier rows + fields, like the org settings groups. */
export function SettingsSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-hidden>
      {[0, 1].map((g) => (
        <div
          key={g}
          className="flex animate-pulse flex-col divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline dark:divide-polar-700 dark:border-polar-700"
        >
          {Array.from({ length: g === 0 ? 2 : 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-3 p-6">
              <div className="h-3.5 w-32 rounded-sm bg-gray-100 dark:bg-polar-700" />
              <div className="h-3 w-56 max-w-full rounded-sm bg-gray-100 dark:bg-polar-700" />
              <div className="h-9 w-full max-w-xs rounded-full bg-gray-100 dark:bg-polar-700" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
