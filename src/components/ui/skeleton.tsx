import { cn } from "@/lib/utils";

// Polar skeleton — ported from `@polar-sh/orbit` Text + `LoadingBox`.
// Light: gray-100 block. Dark (the console): polar-700 block. The
// `animate-pulse` wrapper lives on the parent so a whole row shimmers
// as one unit, exactly like `ToplistSkeleton` in polar-web.
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-sm bg-gray-100 dark:bg-polar-700", className)}
      {...props}
    />
  );
}

// Single-line text placeholder that preserves layout: the hidden
// placeholder holds the line's width while the pulse block overlays it.
// Mirrors `renderSingleLineSkeleton` in orbit's `createText.tsx`.
function SkeletonText({
  placeholder = "Loading...",
  className,
}: {
  placeholder?: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-block", className)}>
      <span style={{ visibility: "hidden" }}>{placeholder}</span>
      <span
        aria-hidden
        className="absolute inset-0 animate-pulse rounded-sm bg-gray-100 dark:bg-polar-700"
      />
    </span>
  );
}

// Multi-line text placeholder — last line renders at 60% width.
// Mirrors `renderMultiLineSkeleton` in orbit's `createText.tsx`.
function SkeletonLines({ lines = 2, className }: { lines?: number; className?: string }) {
  return (
    <span className={cn("block", className)} aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} style={{ display: "flex", alignItems: "center", height: "1lh" }}>
          <span
            className="block animate-pulse rounded-sm bg-gray-100 dark:bg-polar-700"
            style={{
              height: "1em",
              width: i === lines - 1 ? "60%" : "100%",
            }}
          />
        </span>
      ))}
    </span>
  );
}

export { Skeleton, SkeletonText, SkeletonLines };
