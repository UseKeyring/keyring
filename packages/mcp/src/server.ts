import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type KeyringLike } from "./tools.js";

export const SERVER_VERSION = "0.1.0";

export const INSTRUCTIONS = [
  "Keyring is access-control infrastructure: subjects (your product's end-users, keyed by external IDs),",
  "actions (atomic permissions like invoices.refund), roles (named bundles of actions), and grants",
  "(role assignments held by subjects). Access is the union of everything a subject holds.",
  "Use check_access to answer access questions, list_roles / list_actions to explore the graph,",
  "and grant_role / revoke_role / replace_role to change it. Mint browser tokens with create_subject_token.",
  "To explain a decision, call get_subject_access first. Slugs: actions are resource.verb (invoices.refund),",
  "roles are kebab-case (support-lead). Create actions before roles that reference them.",
].join(" ");

export function createServer(keyring: KeyringLike): McpServer {
  const server = new McpServer(
    { name: "keyring", version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, keyring);
  return server;
}
