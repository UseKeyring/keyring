import { docs } from "../../.source/server";
import { loader } from "fumadocs-core/source";

// fumadocs-mdx 15 generates .source/server.ts, and toFumadocsSource() now
// returns the eager { files } shape fumadocs-core 16's loader expects (the
// old lazy-files bridge is gone). `docs` is typed loosely on purpose —
// source.config.ts annotates it `any` because bun's isolated store breaks
// portable inference (TS2742) — so it arrives as `never` here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fumadocsSource = (docs as any).toFumadocsSource();

export const source = loader({
  baseUrl: "/docs",
  source: fumadocsSource,
});
