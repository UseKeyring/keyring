import { docs } from "../../.source";
import { loader } from "fumadocs-core/source";

// Bridge: fumadocs-mdx 11.10's toFumadocsSource() returns a lazy
// `{ files: () => [...] }`, but fumadocs-core 15.8's loader expects
// `{ files: [...] }` (it calls files.map eagerly). Resolve once here —
type MdxFile = {
  type: "page" | "meta";
  path: string;
  absolutePath?: string;
  data: unknown;
};
const mdxSource = docs.toFumadocsSource() as unknown as { files: () => MdxFile[] };

export const source = loader({
  baseUrl: "/docs",
  // Codegen file shapes are version-fluid across fumadocs-mdx/core; the
  // runtime contract ({ type, path, data }) is stable, so stay loose here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  source: { files: mdxSource.files() } as any,
});
