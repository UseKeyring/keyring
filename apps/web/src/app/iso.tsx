/*
 * Isometric line-art kit for the ASCII system's illustrations. Everything is
 * projected from 3D coordinates through `iso`, so faces and edges always
 * meet. Monochrome strokes from the ASCII tokens; accents via props.
 * Draw back-to-front (painter's order): larger x + y is nearer the viewer.
 */

export const C = Math.cos(Math.PI / 6);
export const S = 0.5;
export const U = 30; // px per unit
const OX = 370;
const OY = 78;

export type P = [number, number, number];
export const iso = ([x, y, z]: P): [number, number] => [OX + (x - y) * C * U, OY + ((x + y) * S - z) * U];
export const pts = (ps: P[]) => ps.map((p) => iso(p).map((n) => n.toFixed(1)).join(",")).join(" ");
export const line = (a: P, b: P) => {
  const [x1, y1] = iso(a);
  const [x2, y2] = iso(b);
  return { x1, y1, x2, y2 };
};
export const path = (ps: P[]) => ps.map((p, i) => `${i ? "L" : "M"} ${iso(p).map((n) => n.toFixed(1)).join(" ")}`).join(" ");

export const stroke = { stroke: "var(--a-fg)", strokeWidth: 1, strokeLinejoin: "round" as const, strokeLinecap: "round" as const };
export const faint = { stroke: "var(--a-line-strong)", strokeWidth: 1 };
const MONO = "var(--a-font-mono), ui-monospace, monospace";

type Line = { t: string; cls?: "dim" | "tone" | "accent" | "fg" };
const lineColor = (cls: Line["cls"], tone: string) =>
  cls === "dim" ? "var(--a-muted)" : cls === "tone" ? tone : cls === "accent" ? "var(--a-accent)" : "var(--a-fg)";
const toneColor = (tone?: "ok" | "bad" | "accent") =>
  tone === "ok" ? "var(--a-ok)" : tone === "bad" ? "var(--a-bad)" : tone === "accent" ? "var(--a-accent)" : "var(--a-fg)";

/* Axis-aligned box: top + the two faces toward the viewer (x+w and y+d). */
export function Box({ x, y, z, w, d, h, top: topFill = "var(--a-panel)" }: { x: number; y: number; z: number; w: number; d: number; h: number; top?: string }) {
  const top: P[] = [[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]];
  const right: P[] = [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]];
  const left: P[] = [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]];
  return (
    <g {...stroke}>
      <polygon points={pts(left)} fill="var(--a-bg)" />
      <polygon points={pts(right)} fill="var(--a-raised)" />
      <polygon points={pts(top)} fill={topFill} />
    </g>
  );
}

/* Circle lying in the plane z, centred (cx, cy): an iso ellipse. */
export function Disc({ cx, cy, z, r, fill = "var(--a-panel)", dashed = false }: { cx: number; cy: number; z: number; r: number; fill?: string; dashed?: boolean }) {
  const [px, py] = iso([cx, cy, z]);
  return (
    <ellipse
      cx={px}
      cy={py}
      rx={r * Math.SQRT2 * C * U}
      ry={r * Math.SQRT2 * S * U}
      fill={fill}
      {...(dashed ? { ...faint, strokeDasharray: "3 4" } : stroke)}
    />
  );
}

/* Upright cylinder (a database): body, banded seams, lid. */
export function Cylinder({ cx, cy, z, r, h, bands = 2, lid = "var(--a-panel)" }: { cx: number; cy: number; z: number; r: number; h: number; bands?: number; lid?: string }) {
  const rx = r * Math.SQRT2 * C * U;
  const ry = r * Math.SQRT2 * S * U;
  const [bx, by] = iso([cx, cy, z]);
  const [, ty] = iso([cx, cy, z + h]);
  const body = `M ${bx - rx} ${ty} L ${bx - rx} ${by} A ${rx} ${ry} 0 0 0 ${bx + rx} ${by} L ${bx + rx} ${ty} Z`;
  const seams = Array.from({ length: bands }, (_, i) => {
    const sy = by - ((i + 1) * (by - ty)) / (bands + 1);
    return <path key={i} d={`M ${bx - rx} ${sy} A ${rx} ${ry} 0 0 0 ${bx + rx} ${sy}`} fill="none" {...stroke} />;
  });
  return (
    <g>
      <path d={body} fill="var(--a-raised)" {...stroke} />
      {seams}
      <ellipse cx={bx} cy={ty} rx={rx} ry={ry} fill={lid} {...stroke} />
    </g>
  );
}

/* Thin panel standing in the plane y = Y (faces viewer-left); text skewed onto it. */
export function Panel({ x, y, z, w, h, lines, tone, size = 12.5 }: { x: number; y: number; z: number; w: number; h: number; lines: Line[]; tone?: "ok" | "bad" | "accent" | undefined; size?: number }) {
  const t = 0.18;
  const face: P[] = [[x, y, z], [x + w, y, z], [x + w, y, z + h], [x, y, z + h]];
  const edge: P[] = [[x + w, y - t, z], [x + w, y, z], [x + w, y, z + h], [x + w, y - t, z + h]];
  const lip: P[] = [[x, y - t, z + h], [x + w, y - t, z + h], [x + w, y, z + h], [x, y, z + h]];
  const [tx, ty] = iso([x + 0.4, y, z + h - 0.7]);
  const color = toneColor(tone);
  return (
    <g>
      <g {...stroke}>
        <polygon points={pts(edge)} fill="var(--a-raised)" />
        <polygon points={pts(lip)} fill="var(--a-panel)" />
        <polygon points={pts(face)} fill="var(--a-bg)" />
      </g>
      <g transform={`matrix(${C} ${S} 0 1 ${tx} ${ty})`} fontFamily={MONO} fontSize={size}>
        {lines.map((l, i) => (
          <text key={i} y={i * size * 1.38} fill={lineColor(l.cls, color)}>
            {l.t}
          </text>
        ))}
      </g>
    </g>
  );
}

/* Thin panel standing in the plane x = X (faces viewer-right); text reads up-right. */
export function PanelR({ x, y, z, d, h, lines, tone, size = 12.5 }: { x: number; y: number; z: number; d: number; h: number; lines: Line[]; tone?: "ok" | "bad" | "accent" | undefined; size?: number }) {
  const t = 0.18;
  // spans y from y+d (left on screen) to y (right on screen)
  const face: P[] = [[x, y + d, z], [x, y, z], [x, y, z + h], [x, y + d, z + h]];
  const edge: P[] = [[x - t, y + d, z], [x, y + d, z], [x, y + d, z + h], [x - t, y + d, z + h]];
  const lip: P[] = [[x - t, y, z + h], [x - t, y + d, z + h], [x, y + d, z + h], [x, y, z + h]];
  const [tx, ty] = iso([x, y + d - 0.4, z + h - 0.7]);
  const color = toneColor(tone);
  return (
    <g>
      <g {...stroke}>
        <polygon points={pts(edge)} fill="var(--a-bg)" />
        <polygon points={pts(lip)} fill="var(--a-panel)" />
        <polygon points={pts(face)} fill="var(--a-raised)" />
      </g>
      <g transform={`matrix(${C} ${-S} 0 1 ${tx} ${ty})`} fontFamily={MONO} fontSize={size}>
        {lines.map((l, i) => (
          <text key={i} y={i * size * 1.38} fill={lineColor(l.cls, color)}>
            {l.t}
          </text>
        ))}
      </g>
    </g>
  );
}

/* Points on an arc in the plane y = Y, centred (cx, cz), from angle a0 to a1 (radians). */
export function arcY(cx: number, y: number, cz: number, r: number, a0: number, a1: number, n = 28): P[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + r * Math.cos(a), y, cz + r * Math.sin(a)] as P;
  });
}

/* A tube: outlined thick stroke (fg rim, panel core) — shackles, cables. */
export function Tube({ d, width = 10 }: { d: string; width?: number }) {
  return (
    <g fill="none" strokeLinecap="butt" strokeLinejoin="round">
      <path d={d} stroke="var(--a-fg)" strokeWidth={width} />
      <path d={d} stroke="var(--a-panel)" strokeWidth={width - 2} />
    </g>
  );
}

/* Dashed drafting floor with `+` marks at its corners. */
export function Floor({ from = 2, to = 13, step = 1.5 }: { from?: number; to?: number; step?: number }) {
  const out: React.ReactNode[] = [];
  for (let i = from; i <= to + 1e-6; i += step) {
    out.push(<line key={`a${i}`} {...line([i, from, 0], [i, to, 0])} {...faint} strokeDasharray="2 5" />);
    out.push(<line key={`b${i}`} {...line([from, i, 0], [to, i, 0])} {...faint} strokeDasharray="2 5" />);
  }
  for (const [x, y] of [[from, from], [to, from], [from, to], [to, to]] as const) {
    const [cx, cy] = iso([x, y, 0]);
    out.push(
      <g key={`c${x}${y}`} {...faint}>
        <line x1={cx - 4} y1={cy} x2={cx + 4} y2={cy} />
        <line x1={cx} y1={cy - 4} x2={cx} y2={cy + 4} />
      </g>,
    );
  }
  return <g>{out}</g>;
}

/* Floating / flowing motion shared by every scene; off under reduced motion. */
export function IsoSvg({ viewBox, label, children }: { viewBox: string; label: string; children: React.ReactNode }) {
  return (
    <svg viewBox={viewBox} preserveAspectRatio="xMidYMid meet" role="img" aria-label={label} style={{ display: "block", width: "100%", height: "auto" }}>
      <style>{`
        @keyframes iso-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-7px) } }
        @keyframes iso-dash { to { stroke-dashoffset: -18 } }
        @keyframes iso-blink { 50% { opacity: 0 } }
        .iso-float { animation: iso-float 5s ease-in-out infinite; }
        .iso-float.slow { animation-duration: 7s; animation-delay: -2s; }
        .iso-flow { animation: iso-dash 1.2s linear infinite; }
        .iso-blink { animation: iso-blink 1.1s steps(1) infinite; }
        @media (prefers-reduced-motion: reduce) { .iso-float, .iso-flow, .iso-blink { animation: none } }
      `}</style>
      {children}
    </svg>
  );
}
