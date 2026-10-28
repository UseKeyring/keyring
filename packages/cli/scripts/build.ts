// Bundle the CLI (workspace deps inlined, real deps external) + ship the schema.
import { chmodSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { POLICY_JSON_SCHEMA } from "../src/policy.ts";

rmSync("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  external: ["pg", "@electric-sql/pglite", "@electric-sql/pglite/*", "@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*", "zod"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
copyFileSync("../../drizzle/native.sql", "dist/native.sql");
writeFileSync("policy.schema.json", `${JSON.stringify(POLICY_JSON_SCHEMA, null, 2)}\n`);
chmodSync("dist/index.js", 0o755);
console.log("built dist/index.js + dist/native.sql");
