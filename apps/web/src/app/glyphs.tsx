/*
 * Hand-drawn one-stroke line glyphs — Polar's only decorative voice.
 * Pure-black stroke, transparent fill, sharp bounding box. Jitter is
 * deterministic (seeded) so server and client render identically.
 *
 * Server component (no "use client"): coordinates are computed once at
 * render time and shipped as static SVG — nothing re-runs on hydration,
 * so engine-level Math.sin/cos ULP differences can't mismatch.
 * Coordinates are quantized to 3 decimals to keep output stable + small.
 */

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Quantize to 3 decimals: collapses cross-engine float noise and shrinks HTML.
function q(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function StarburstLines({ count, seed, r1, r2 }: { count: number; seed: number; r1: number; r2: number }) {
  const rand = seeded(seed);
  const lines = Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.08;
    const inner = r1 * (0.9 + rand() * 0.2);
    const outer = r2 * (0.92 + rand() * 0.16);
    return {
      x1: q(60 + Math.cos(a) * inner),
      y1: q(60 + Math.sin(a) * inner),
      x2: q(60 + Math.cos(a) * outer),
      y2: q(60 + Math.sin(a) * outer),
    };
  });
  return (
    <g>
      {lines.map((l, i) => (
        <line key={i} {...l} />
      ))}
    </g>
  );
}

function GlyphFrame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      role="img"
      aria-label={label}
      className="h-24 w-24 text-ink"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
    >
      {children}
    </svg>
  );
}

export function GlyphStarburst() {
  return (
    <GlyphFrame label="Starburst">
      <StarburstLines count={12} seed={7} r1={10} r2={44} />
      <circle cx={60} cy={60} r={2.5} />
    </GlyphFrame>
  );
}

export function GlyphDenseStarburst() {
  return (
    <GlyphFrame label="Dense starburst">
      <StarburstLines count={24} seed={21} r1={8} r2={45} />
      <circle cx={60} cy={60} r={2} />
    </GlyphFrame>
  );
}

export function GlyphOrbitCircles() {
  return (
    <GlyphFrame label="Nested circles">
      <circle cx={58} cy={62} r={38} />
      <circle cx={58} cy={62} r={25} />
      <circle cx={58} cy={62} r={12} />
      <circle cx={94} cy={30} r={6} />
    </GlyphFrame>
  );
}

export function GlyphSpiral() {
  const pts: string[] = [];
  for (let t = 0; t <= Math.PI * 6; t += 0.15) {
    const r = 4 + t * 2.1;
    pts.push(`${t === 0 ? "M" : "L"}${(60 + Math.cos(t) * r).toFixed(1)},${(60 + Math.sin(t) * r).toFixed(1)}`);
  }
  const d = pts.join(" ");
  return (
    <GlyphFrame label="Inward spiral">
      <path d={d} />
    </GlyphFrame>
  );
}

export function GlyphSerpentine() {
  return (
    <GlyphFrame label="Serpentine path">
      <path d="M18,88 C34,88 34,64 52,64 C70,64 70,44 88,44 C96,44 100,40 102,34" />
      <path d="M96,34 L102,34 L100,41" />
      <path d="M18,100 C40,100 40,78 62,78" />
      <path d="M56,78 L62,78 L60,84" />
    </GlyphFrame>
  );
}

export function GlyphRules() {
  const rand = seeded(99);
  const rows = Array.from({ length: 7 }, (_, i) => {
    const w = q(84 * (0.55 + rand() * 0.45));
    return { y: 22 + i * 12, w };
  });
  return (
    <GlyphFrame label="Stack of rules">
      {rows.map((r, i) => (
        <line key={i} x1={60 - r.w / 2} y1={r.y} x2={60 + r.w / 2} y2={r.y} />
      ))}
    </GlyphFrame>
  );
}
