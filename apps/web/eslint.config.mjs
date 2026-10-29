import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Flat config (eslint-config-next 16 dropped eslintrc). Same presets the old
// .eslintrc.json extended: next/core-web-vitals + next/typescript.
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // New in eslint-plugin-react-hooks 7 (shipped by eslint-config-next 16).
    // They flag pre-existing patterns (e.g. setMounted(true) in an effect) in
    // 9 places; kept as warnings so the Next 16 upgrade doesn't silently
    // change component behaviour. Fix the call sites, then promote to error.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
    },
  },
  globalIgnores(["node_modules/**", ".next/**", "out/**", "next-env.d.ts", ".source/**", ".open-next/**"]),
]);
