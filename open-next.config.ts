import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Fully-dynamic app (no ISR/revalidate/PPR) — defaults are enough, no KV/R2
// cache bindings required. See wrangler.jsonc for the Worker configuration.
export default defineCloudflareConfig();
