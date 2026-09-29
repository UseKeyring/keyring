/**
 * Embeds the customer-mirror templates into a generated TS module so the
 * connect route can ship them to Supabase without runtime `fs` access
 * (Cloudflare Workers have no filesystem, and templates/ isn't deployed).
 *
 * Runs on `prebuild` and is committed, so typecheck/dev always see it.
 * Re-run after editing anything under templates/customer-mirror/.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const outFile = resolve(here, "..", "src", "lib", "connect-templates.generated.ts");

const FILES = {
  mirrorSchemaSql: "templates/customer-mirror/schema.sql",
  signupTriggerSql: "templates/customer-mirror/signup-trigger.sql",
  applierTs: "templates/customer-mirror/applier.ts",
  signupSyncTs: "templates/customer-mirror/signup-sync.ts",
} as const;

const parts: string[] = [
  "/**",
  " * GENERATED — do not edit. Run `bun run prebuild` (or edit the source",
  " * templates under templates/customer-mirror/ then re-run it).",
  " */",
];
for (const [key, rel] of Object.entries(FILES)) {
  const content = readFileSync(resolve(repoRoot, rel), "utf8");
  parts.push(`export const ${key} = ${JSON.stringify(content)};`);
}
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, parts.join("\n") + "\n");
console.log(`embedded ${Object.keys(FILES).length} templates → ${outFile}`);
