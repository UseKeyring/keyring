#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Keyring, detectKeyKind } from "@keyring/sdk";
import { createServer } from "./server.js";

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[keyring-mcp] ${name} is required (e.g. KEYRING_API_KEY=kr_sk_live_… KEYRING_BASE_URL=https://app.example.com)`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const apiKey = requiredEnv("KEYRING_API_KEY");
  const baseUrl = requiredEnv("KEYRING_BASE_URL");
  if (detectKeyKind(apiKey) !== "secret") {
    console.error("[keyring-mcp] KEYRING_API_KEY must be a secret key (kr_sk_live_… or legacy kr_live_…). Publishable keys cannot manage grants.");
    process.exit(1);
  }
  const server = createServer(new Keyring({ apiKey, baseUrl }));
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`[keyring-mcp] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
