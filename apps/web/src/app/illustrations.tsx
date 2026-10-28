/*
 * Per-page isometric scenes, drawn with the shared kit in ./iso.
 * TryItIllustration — terminal running `keyring dev`, wired to its embedded DB.
 * SignInIllustration — padlock with an accent keyhole and a floating session card.
 * WaitlistIllustration — tickets queueing at a gate; the one at the front is approved.
 */
import {
  Box,
  C,
  Cylinder,
  Floor,
  IsoSvg,
  Panel,
  PanelR,
  S,
  Tube,
  arcY,
  faint,
  iso,
  line,
  path,
  pts,
  stroke,
  type P,
} from "./iso";

const MONO = "var(--a-font-mono), ui-monospace, monospace";

/* Text lying on a top face (plane z), reading along +x. */
function TopText({ at, children, size = 10.5, fill = "var(--a-muted)" }: { at: P; children: string; size?: number; fill?: string }) {
  const [tx, ty] = iso(at);
  return (
    <text transform={`matrix(${C} ${S} ${-C} ${S} ${tx} ${ty})`} fontFamily={MONO} fontSize={size} fill={fill}>
      {children}
    </text>
  );
}

export function TryItIllustration() {
  return (
    <IsoSvg viewBox="60 24 620 456" label="Illustration: a terminal runs npx @usekeyring/cli dev, boots an embedded Postgres, and the first check is allowed">
      <Floor />

      {/* embedded postgres, back right */}
      <Cylinder cx={11} cy={4.6} z={0} r={1.35} h={2.7} bands={2} />
      <TopText at={[10.1, 4.9, 2.7]}>.keyring/</TopText>

      {/* wire: terminal → db */}
      <path
        className="iso-flow"
        d={path([[6.0, 8.3, 0.05], [11, 8.3, 0.05], [11, 6.1, 0.05]])}
        stroke="var(--a-accent)"
        strokeWidth={1.2}
        strokeDasharray="4 5"
        fill="none"
      />

      {/* terminal monolith on a stand */}
      <Box x={4.6} y={7.6} z={0} w={1.4} d={1.4} h={0.6} />
      <Box x={1} y={8.2} z={0.6} w={8.4} d={0.7} h={5.2} />
      <Panel
        x={1.3}
        y={8.95}
        z={0.9}
        w={7.8}
        h={4.6}
        size={11.5}
        tone="ok"
        lines={[
          { t: "$ npx @usekeyring/cli dev", cls: "fg" },
          { t: "✓ schema installed", cls: "tone" },
          { t: "✓ root key minted", cls: "tone" },
          { t: "→ console :4983", cls: "dim" },
          { t: "" },
          { t: "$ keyring check u1 docs.edit", cls: "fg" },
          { t: "allowed", cls: "tone" },
        ]}
      />

      {/* timer badge, nearest */}
      <g className="iso-float">
        <PanelR x={12.6} y={9.8} z={2.2} d={4.4} h={2.0} tone="accent" lines={[{ t: "00:30", cls: "tone" }, { t: "to first allow", cls: "dim" }]} />
      </g>
    </IsoSvg>
  );
}

export function SignInIllustration() {
  const shackle = path([[6.0, 6.5, 3.6], [6.0, 6.5, 5.0], ...arcY(7.2, 6.5, 5.0, 1.2, Math.PI, 0), [8.4, 6.5, 5.0], [8.4, 6.5, 3.6]]);
  const keyhole = arcY(7.2, 7.4, 2.3, 0.34, 0, Math.PI * 2, 24);
  return (
    <IsoSvg viewBox="60 24 620 456" label="Illustration: a padlock with a keyhole and a floating session card for your account">
      <Floor />

      {/* workspace tag, front left */}
      <g className="iso-float slow">
        <Panel x={0.8} y={9.4} z={1.6} w={4.2} h={1.7} lines={[{ t: "workspace", cls: "dim" }, { t: "acme · owner" }]} />
      </g>

      {/* padlock: body, then shackle standing in its top */}
      <Box x={5} y={5.6} z={0} w={4.4} d={1.8} h={3.6} />
      <polygon points={pts([[5.3, 7.4, 0.3], [9.1, 7.4, 0.3], [9.1, 7.4, 3.3], [5.3, 7.4, 3.3]])} fill="none" {...faint} />
      {[5.6, 6.2, 6.8].map((y) => (
        <line key={y} {...line([9.4, y, 0.5], [9.4, y, 3.1])} {...faint} />
      ))}
      <Tube d={shackle} width={11} />
      <polygon points={pts(keyhole)} fill="var(--a-accent)" {...stroke} />
      <polygon points={pts([[7.05, 7.4, 2.05], [7.35, 7.4, 2.05], [7.5, 7.4, 1.2], [6.9, 7.4, 1.2]])} fill="var(--a-accent)" {...stroke} />

      {/* session card, nearest */}
      <g className="iso-float">
        <PanelR
          x={13.0}
          y={7.6}
          z={2.4}
          d={4.6}
          h={2.5}
          size={11.5}
          tone="accent"
          lines={[{ t: "you@company.com" }, { t: "github · email", cls: "dim" }, { t: "→ console", cls: "tone" }]}
        />
      </g>
    </IsoSvg>
  );
}

export function WaitlistIllustration() {
  // Tickets face the viewer (plane y) and queue along +y in front of a gate spanning x;
  // the gate stands behind them so isometric overlap never hides a ticket.
  const ticket = (y: number, n: string, approved = false) => (
    <Panel
      key={n}
      x={5.6}
      y={y}
      z={0.7}
      w={3.2}
      h={1.8}
      size={11.5}
      tone={approved ? "ok" : undefined}
      lines={[{ t: `#${n}`, cls: approved ? "tone" : "fg" }, { t: approved ? "approved" : "pending", cls: approved ? "tone" : "dim" }]}
    />
  );
  return (
    <IsoSvg viewBox="60 -14 620 470" label="Illustration: waitlist tickets queue at a gate; the first one is approved">
      <Floor />

      {/* queue lane */}
      <line {...line([7.2, 1.0, 0], [7.2, 13.6, 0])} stroke="var(--a-accent)" strokeWidth={1.2} strokeDasharray="4 5" className="iso-flow" />

      {/* gate: pillars + crossbar spanning x, sign on its front face */}
      <Box x={2.6} y={3.6} z={0} w={0.7} d={0.7} h={4.6} />
      <Box x={11.9} y={3.6} z={0} w={0.7} d={0.7} h={4.6} />
      <Box x={2.6} y={3.6} z={4.6} w={10.0} d={0.7} h={0.6} />
      <text
        transform={(() => {
          const [tx, ty] = iso([4.4, 4.3, 4.76]);
          return `matrix(${C} ${S} 0 1 ${tx} ${ty})`;
        })()}
        fontFamily={MONO}
        fontSize={10.5}
        fill="var(--a-muted)"
      >
        approved emails only
      </text>

      {/* the queue, waiting in front */}
      <g className="iso-float">{ticket(6.2, "039", true)}</g>
      {ticket(8.4, "040")}
      {ticket(10.6, "041")}

      {/* count tag, right */}
      <g className="iso-float slow">
        <PanelR x={13.8} y={5.8} z={1.6} d={4.6} h={1.7} lines={[{ t: "waitlist", cls: "dim" }, { t: "1 in · 2 pending" }]} />
      </g>
    </IsoSvg>
  );
}
