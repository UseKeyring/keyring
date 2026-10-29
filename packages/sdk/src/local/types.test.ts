import { expect, test } from "bun:test";
import { join } from "node:path";

// Compiles test/local-types.ts: every `@ts-expect-error` there must be a real
// type error (typo'd action, wrong-scope role, unknown space, …).
test("typed policy slugs (tsc -p tsconfig.typetest.json)", () => {
  const root = join(import.meta.dir, "../..");
  const tsc = join(root, "node_modules/.bin/tsc");
  const proc = Bun.spawnSync([tsc, "-p", join(root, "tsconfig.typetest.json")], { cwd: root });
  const out = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  expect(out).toBe("");
  expect(proc.exitCode).toBe(0);
}, 60_000);
