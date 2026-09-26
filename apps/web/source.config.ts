import { defineConfig, defineDocs } from "fumadocs-mdx/config";

// Loose annotation: bun's isolated store (.bun/…) breaks portable type
// inference for the zod-backed schema (TS2742), and codegen reads this
// file at build time regardless of the annotation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const docs: any = defineDocs({
  dir: "content/docs",
});

export default defineConfig();
