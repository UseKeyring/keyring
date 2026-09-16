import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Keyring } from "@keyring/sdk";
import { registerTools } from "./tools.js";

export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = [
  "Keyring is access-control infrastructure: subjects (your product's end-users, keyed by external IDs),",
  "actions (atomic permissions like invoices.refund), roles (named bundles of actions), and grants",
  "(role assignments held by subjects). Access is the union of everything a subject holds.",
  "Use check_access to answer access questions, list_roles / list_actions to explore the graph,",
  "and grant_role / revoke_role / replace_role to change it. Mint browser tokens with create_subject_token.",
].join(" ");

export function createServer(keyring: Keyring): McpServer {
  const server = new McpServer(
    { name: "keyring", version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, keyring);
  return server;
}
