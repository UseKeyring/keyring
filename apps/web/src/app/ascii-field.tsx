"use client";

import { useEffect, useRef } from "react";

/*
 * Footer field: concentric rings of text flowing around a point above the
 * canvas (no centre disc), inside an inked band that glitch-dissolves into the page. Drawn on
 * a monospace grid (every glyph sits in a cell) so it stays ASCII. Colours
 * come from the ASCII tokens, so it inverts with the theme. Pauses offscreen;
 * one still frame under prefers-reduced-motion. Pointer scrambles nearby cells.
 */

type Kind = "fg" | "dim" | "hi";
const SEGMENTS: [string, Kind][] = [
  ["KEYRING", "fg"], [" · ", "dim"], ["ALLOW", "hi"], [" · ", "dim"], ["DENY", "fg"], [" · ", "dim"],
  ["ROLES", "fg"], [" · ", "dim"], ["ACTIONS", "fg"], [" · ", "dim"], ["GRANTS", "fg"], [" · ", "dim"],
  ["OPEN SOURCE", "fg"], [" · ", "dim"], ["MIT", "fg"], [" · ", "dim"],
];
const PHRASE = SEGMENTS.flatMap(([t, k]) => [...t].map((ch) => ({ ch, k })));
const GLYPHS = "KEYRINGALLOWDENYROLES·:./-+*_01#";

/* Cheap deterministic hash → [0, 1). */
function hash(a: number, b: number, c: number) {
  const n = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

export function AsciiField({ height = 300 }: { height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pointer = { x: -1e4, y: -1e4 };
    let W = 0;
    let H = 0;
    let cw = 8;
    const chH = 16;
    let raf = 0;
    let visible = true;
    let last = 0;

    const fontFamily = getComputedStyle(canvas).fontFamily || "ui-monospace, monospace";
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `500 12px ${fontFamily}`;
      cw = Math.ceil(ctx.measureText("M").width + 1);
    };

    const draw = (t: number) => {
      if (W <= 0 || H <= 0) return; // not laid out yet (or hidden)
      const css = getComputedStyle(canvas);
      const tok = (n: string) => css.getPropertyValue(n).trim() || "#888";
      const ink = tok("--a-fg");
      const onInk = tok("--a-bg");
      const muted = tok("--a-muted");
      const dim = tok("--a-dim");
      const accent = tok("--a-accent");

      ctx.clearRect(0, 0, W, H);
      ctx.font = `500 12px ${fontFamily}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";

      const cols = Math.ceil(W / cw);
      const rows = Math.ceil(H / chH);
      const cx = W / 2;
      const cy = -H * 0.42;
      const R0 = H * 0.62;
      const spacing = chH * 2.9;
      const bandH = H * 0.3;
      const bucket = Math.floor(t * 2.2); // glitch refresh rate

      // Wavy edge of the ink, per column.
      const edge = (x: number) => H * 0.5 + Math.sin(x * 0.011 + t * 0.35) * H * 0.07 + Math.sin(x * 0.031 - t * 0.6) * H * 0.035;

      for (let i = 0; i < cols; i++) {
        const x = i * cw + cw / 2;
        const e = edge(x);
        // ink column
        ctx.fillStyle = ink;
        ctx.globalAlpha = 1;
        ctx.fillRect(i * cw, 0, cw, Math.floor(e / chH) * chH);

        for (let j = 0; j < rows; j++) {
          const y = j * chH + chH / 2;
          const dx = x - cx;
          const dy = y - cy;
          const d = Math.hypot(dx, dy);
          const k = Math.round((d - R0) / spacing);
          const onRing = k >= 0 && Math.abs(d - (R0 + k * spacing)) < chH * 0.5;
          let ringChar: { ch: string; k: Kind } | null = null;
          if (onRing) {
            // Index by column, not angle: each ring's run of cells reads as
            // continuous text as it steps down the grid (no doubled letters).
            const dir = k % 2 === 0 ? 1 : -1;
            const idx = Math.floor(i + dir * t * (1.6 + k * 0.35) + k * 13);
            ringChar = PHRASE[((idx % PHRASE.length) + PHRASE.length) % PHRASE.length]!;
          }

          const near = Math.hypot(x - pointer.x, y - pointer.y) < cw * 6;
          const r = hash(i, j, near ? bucket * 7 + 3 : bucket);
          const scramble = near ? GLYPHS[Math.floor(hash(j, i, bucket) * GLYPHS.length)]! : null;

          if (y < Math.floor(e / chH) * chH) {
            // inside the ink
            if (near && r < 0.35) {
              ctx.fillStyle = onInk;
              ctx.fillRect(i * cw, j * chH, cw, chH);
              ctx.fillStyle = ink;
              ctx.fillText(scramble!, x, y);
            } else if (ringChar && ringChar.ch !== " ") {
              ctx.fillStyle = ringChar.k === "hi" ? accent : ringChar.k === "dim" ? muted : onInk;
              ctx.fillText(scramble ?? ringChar.ch, x, y);
            } else if (hash(i, j, 0) < 0.16) {
              ctx.fillStyle = muted;
              ctx.fillText("·", x, y);
            }
            continue;
          }

          const depth = (y - e) / bandH; // 0 at the edge → 1 at the band floor
          if (depth < 1) {
            const glyph = scramble ?? (ringChar && ringChar.ch !== " " ? ringChar.ch : GLYPHS[Math.floor(hash(i, j, bucket + 1) * GLYPHS.length)]!);
            if (r < (1 - depth) * 0.32) {
              ctx.fillStyle = ink;
              ctx.fillRect(i * cw, j * chH, cw, chH);
              ctx.fillStyle = ringChar?.k === "hi" ? accent : onInk;
              ctx.fillText(glyph, x, y);
            } else if (r < (1 - depth) * 0.72) {
              ctx.fillStyle = r < 0.06 ? accent : muted;
              ctx.fillText(glyph, x, y);
            }
          } else if (r < 0.006 || (near && r < 0.2)) {
            ctx.fillStyle = dim;
            ctx.fillText(scramble ?? GLYPHS[Math.floor(hash(i, j, 9) * GLYPHS.length)]!, x, y);
          }
        }
      }
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden || now - last < 40) return; // ~25fps
      last = now;
      draw(now / 1000);
    };

    resize();
    draw(0);
    const ro = new ResizeObserver(() => {
      resize();
      draw(performance.now() / 1000);
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
    });
    io.observe(canvas);
    const move = (e: PointerEvent) => {
      const b = canvas.getBoundingClientRect();
      pointer.x = e.clientX - b.left;
      pointer.y = e.clientY - b.top;
      if (reduced) draw(performance.now() / 1000);
    };
    const leave = () => {
      pointer.x = -1e4;
      pointer.y = -1e4;
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerleave", leave);
    if (!reduced) raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{ display: "block", width: "100%", height, fontFamily: "var(--a-font-mono), ui-monospace, monospace" }}
    />
  );
}
