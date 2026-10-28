/*
 * Hero illustration — isometric line art (Postgres rack, floating key,
 * laptop running `keyring dev`, decision panels). Everything is projected
 * from 3D coordinates with one helper, so faces and edges always meet.
 * Monochrome strokes from the ASCII tokens; one accent. Painter's order.
 */

import { Box, C, Disc, Panel, S, faint, iso, line, pts, stroke, type P } from "./iso";

function Rack() {
  const units = [0, 1.5, 3];
  return (
    <g>
      {units.map((z, i) => (
        <g key={z}>
          <Box x={5} y={4.6} z={z} w={4.4} d={4.4} h={1.35} />
          {/* drive-bay slot + LEDs on the left (y-facing) face */}
          <line {...line([5.5, 9, z + 0.45], [7.6, 9, z + 0.45])} {...stroke} />
          <line {...line([5.5, 9, z + 0.8], [7.6, 9, z + 0.8])} {...faint} />
          {[8.25, 8.75].map((x, k) => {
            const [cx, cy] = iso([x, 9, z + 0.62]);
            return <circle key={x} cx={cx} cy={cy} r={2.2} fill={i === 1 && k === 0 ? "var(--a-accent)" : "var(--a-line-strong)"} />;
          })}
          {/* vents on the right (x-facing) face */}
          {[5.4, 5.9, 6.4, 6.9, 7.4].map((y) => (
            <line key={y} {...line([9.4, y, z + 0.4], [9.4, y, z + 0.95])} {...faint} />
          ))}
        </g>
      ))}
      {/* label plate on top */}
      <g fontFamily="var(--a-font-mono), ui-monospace, monospace" fontSize="10" fill="var(--a-muted)">
        <text transform={(() => { const [tx, ty] = iso([5.55, 8.2, 4.35]); return `matrix(${C} ${S} ${-C} ${S} ${tx} ${ty})`; })()}>postgres · keyring</text>
      </g>
    </g>
  );
}

/* Key lying flat in the plane z, ring at (rx, ry), shaft along +x. */
function Key({ z }: { z: number }) {
  const rx = 6.1;
  const ry = 6.0;
  const t = 0.32;
  return (
    <g className="hero-key">
      {/* drop shadow on the rack top */}
      <Disc cx={rx + 1.4} cy={ry + 0.5} z={4.35} r={1.9} fill="none" dashed />
      {/* ring: underside + top + hole */}
      <Disc cx={rx} cy={ry} z={z} r={1.15} fill="var(--a-raised)" />
      <Disc cx={rx} cy={ry} z={z + t} r={1.15} fill="var(--a-panel)" />
      <Disc cx={rx} cy={ry} z={z + t} r={0.5} fill="var(--a-bg)" />
      {/* shaft + teeth */}
      <Box x={rx + 1.0} y={ry - 0.25} z={z} w={3.4} d={0.5} h={t} />
      <Box x={rx + 3.55} y={ry + 0.25} z={z} w={0.38} d={0.7} h={t} top="var(--a-accent)" />
      <Box x={rx + 2.85} y={ry + 0.25} z={z} w={0.38} d={0.45} h={t} />
    </g>
  );
}

function Laptop() {
  const x = 0.6;
  const y = 10.4;
  const w = 3.6;
  const d = 2.4;
  const screen: P[] = [[x, y, 0.16], [x + w, y, 0.16], [x + w, y - 0.5, 2.6], [x, y - 0.5, 2.6]];
  const [tx, ty] = iso([x + 0.35, y - 0.12, 2.05]);
  return (
    <g>
      <Box x={x} y={y} z={0} w={w} d={d} h={0.16} />
      {/* keyboard rows */}
      {[0.55, 0.95, 1.35].map((o) => (
        <line key={o} {...line([x + 0.4, y + o, 0.16], [x + w - 0.4, y + o, 0.16])} {...faint} />
      ))}
      <polygon points={pts(screen)} fill="var(--a-bg)" {...stroke} />
      <g transform={`matrix(${C} ${S} 0 1 ${tx} ${ty})`} fontFamily="var(--a-font-mono), ui-monospace, monospace" fontSize="10.5">
        <text fill="var(--a-muted)">$ <tspan fill="var(--a-fg)">keyring dev</tspan></text>
        <text y={14} fill="var(--a-muted)">→ :4983</text>
        <text y={28} fill="var(--a-ok)">policy ok</text>
      </g>
    </g>
  );
}

export function HeroIllustration() {
  const grid: React.ReactNode[] = [];
  for (let i = 2; i <= 13; i += 1.5) {
    grid.push(<line key={`a${i}`} {...line([i, 2, 0], [i, 13, 0])} {...faint} strokeDasharray="2 5" />);
    grid.push(<line key={`b${i}`} {...line([2, i, 0], [13, i, 0])} {...faint} strokeDasharray="2 5" />);
  }
  const cross = (p: P, k: string) => {
    const [cx, cy] = iso(p);
    return (
      <g key={k} {...faint}>
        <line x1={cx - 4} y1={cy} x2={cx + 4} y2={cy} />
        <line x1={cx} y1={cy - 4} x2={cx} y2={cy + 4} />
      </g>
    );
  };
  return (
    <svg viewBox="38 4 604 468" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Illustration: your app calls keyring.check, Postgres evaluates the grant, and returns allow or deny" style={{ display: "block", width: "100%", height: "auto" }}>
      <style>{`
        @keyframes hero-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-7px) } }
        @keyframes hero-dash { to { stroke-dashoffset: -18 } }
        .hero-key { animation: hero-float 5s ease-in-out infinite; }
        .hero-flow { animation: hero-dash 1.2s linear infinite; }
        @media (prefers-reduced-motion: reduce) { .hero-key, .hero-flow { animation: none } }
      `}</style>
      {grid}
      {cross([2, 2, 0], "c0")}
      {cross([13, 2, 0], "c1")}
      {cross([2, 13, 0], "c2")}
      {cross([13, 13, 0], "c3")}

      {/* tether: code bubble ↓ laptop */}
      <line {...line([2.2, 8.6, 3.9], [2.2, 9.95, 2.5])} {...faint} strokeDasharray="2 4" />
      {/* flow: laptop → rack */}
      <path
        className="hero-flow"
        d={`M ${iso([3.4, 10.0, 1.4]).join(" ")} L ${iso([5, 9.2, 1.4]).join(" ")}`}
        stroke="var(--a-accent)"
        strokeWidth={1.2}
        strokeDasharray="4 5"
        fill="none"
      />
      <Rack />
      <Key z={5.6} />

      {/* decision panels, right */}
      <path className="hero-flow" d={`M ${iso([9.4, 6.4, 3.6]).join(" ")} L ${iso([11, 6.4, 5.1]).join(" ")}`} stroke="var(--a-ok)" strokeWidth={1.2} strokeDasharray="4 5" fill="none" />
      <Panel x={10.6} y={5.6} z={5.1} w={3.8} h={1.9} tone="ok" lines={[{ t: "ALLOW", cls: "tone" }, { t: "via finance", cls: "dim" }]} />
      <path className="hero-flow" d={`M ${iso([9.4, 8.2, 1.2]).join(" ")} L ${iso([11.4, 9.4, 2.0]).join(" ")}`} stroke="var(--a-line-strong)" strokeWidth={1} strokeDasharray="4 5" fill="none" />
      <Panel x={11.2} y={9.6} z={2.0} w={3.8} h={1.9} tone="bad" lines={[{ t: "DENY", cls: "tone" }, { t: "billing.*", cls: "dim" }]} />

      <Laptop />
      {/* code bubble, floating over the laptop */}
      <Panel
        x={0.0}
        y={8.6}
        z={3.9}
        w={6.0}
        h={2.4}
        lines={[
          { t: "keyring.check(" },
          { t: '  "user_123",', cls: "dim" },
          { t: '  "invoices.refund")', cls: "dim" },
        ]}
      />
    </svg>
  );
}
