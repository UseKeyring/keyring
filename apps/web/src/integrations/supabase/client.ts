import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

function getEnv(): { url: string; key: string } {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? process.env["SUPABASE_URL"] ?? "";
  const key =
    process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ??
    process.env["SUPABASE_PUBLISHABLE_KEY"] ??
    "";
  if (!url || !key) {
    throw new Error(
      "Missing Supabase environment variables: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
    );
  }
  return { url, key };
}

let browserClient: ReturnType<typeof createClient<Database>> | undefined;
let browserClientKey = "";

export function getSupabaseBrowserClient() {
  const { url, key } = getEnv();
  // Key the singleton so preview HMR / tests that swap env vars don't
  // keep talking to the first project that was constructed.
  const cacheKey = `${url}|${key}`;
  if (!browserClient || browserClientKey !== cacheKey) {
    browserClient = createClient<Database>(url, key, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    browserClientKey = cacheKey;
  }
  return browserClient;
}
