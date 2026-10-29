import { rehypeCodeDefaultOptions } from "fumadocs-core/mdx-plugins";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";

// Loose annotation: bun's isolated store (.bun/…) breaks portable type
// inference for the zod-backed schema (TS2742), and codegen reads this
// file at build time regardless of the annotation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const docs: any = defineDocs({
  dir: "content/docs",
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        // Expose each fence's language on <pre> so the docs code window
        // (src/components/mdx.tsx) can title itself "~/bash", "~/ts", ...
        {
          name: "keyring:data-language",
          pre(node) {
            node.properties["data-language"] = this.options.lang;
          },
        },
      ],
    },
  },
});
