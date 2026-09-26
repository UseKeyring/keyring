import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Keyring, KeyringError } from "@usekeyring/sdk";
import { z } from "zod";

export const SubjectSchema = z
  .string()
  .min(1)
  .describe("External subject ID — your product's user key (e.g. user_123)");

export const PermissionSchema = z
  .string()
  .min(1)
  .describe("Action slug to check (e.g. invoices.refund)");

export const RoleSchema = z
  .string()
  .min(1)
  .describe("Role slug (e.g. support, finance)");

export const CheckAccessSchema = {
  subject: SubjectSchema,
  permission: PermissionSchema,
};

export const GrantRoleSchema = {
  role: RoleSchema,
  subject: SubjectSchema,
  displayName: z
    .string()
    .optional()
    .describe("Optional human-readable label stored with the grant"),
};

export const RevokeRoleSchema = {
  role: RoleSchema,
  subject: SubjectSchema,
};

export const ReplaceRoleSchema = {
  subject: SubjectSchema,
  from: RoleSchema.describe("Role slug to revoke"),
  to: RoleSchema.describe("Role slug to grant"),
  displayName: z
    .string()
    .optional()
    .describe("Optional human-readable label stored with the new grant"),
};

export const CreateRoleSchema = {
  slug: z.string().min(1).describe("Role slug, lowercase with dashes (e.g. player)"),
  name: z.string().min(1).describe("Human-readable role name (e.g. Player)"),
  description: z.string().optional().describe("Optional description"),
  permissions: z
    .array(z.string().min(1))
    .optional()
    .describe("Action slugs to attach — must already exist (create them first)"),
};

export const CreateActionSchema = {
  slug: z.string().min(1).describe("Action slug, resource.action (e.g. games.play)"),
  name: z.string().min(1).describe("Human-readable action name (e.g. Play games)"),
  category: z.string().optional().describe("Single Capitalized word, default General"),
  description: z.string().optional().describe("Optional description"),
};

export const CreateSubjectTokenSchema = {
  subject: SubjectSchema,
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(86400 * 30)
    .optional()
    .describe("Token lifetime in seconds (max 30 days). Defaults server-side when omitted."),
};

type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(payload: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function formatToolError(err: unknown): TextResult {
  if (err instanceof KeyringError) {
    const hint =
      err.status === 401
        ? " Check KEYRING_API_KEY — it must be a valid secret key (kr_sk_live_… or legacy kr_live_…)."
        : err.status === 403
          ? " The key lacks the required scope (check, grants.write, roles.read, roles.write, actions.read, actions.write, subject_tokens.write) or the subject/role is outside the active workspace."
          : "";
    return {
      content: [{ type: "text", text: `Keyring API error (${err.status}): ${err.message}.${hint}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: `Keyring request failed: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

/** Registers every Keyring tool on the server. Exported for testability. */
export function registerTools(server: McpServer, keyring: Keyring): void {
  server.tool(
    "check_access",
    "Check whether a subject is allowed to perform an action. Requires the `check` scope.",
    CheckAccessSchema,
    { readOnlyHint: true, openWorldHint: false },
    async ({ subject, permission }) => {
      try {
        return ok(await keyring.check(subject, permission));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.tool(
    "list_roles",
    "List all roles in the active workspace. Requires the `roles.read` scope.",
    {},
    { readOnlyHint: true, openWorldHint: false },
    async () => {
      try {
        return ok({ roles: await keyring.listRoles() });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.tool(
    "list_actions",
    "List all actions (permissions) in the active workspace. Requires the `actions.read` scope.",
    {},
    { readOnlyHint: true, openWorldHint: false },
    async () => {
      try {
        return ok({ actions: await keyring.listActions() });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.tool(
    "grant_role",
    "Grant a role to a subject (gives them every action the role contains). Requires the `grants.write` scope.",
    GrantRoleSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ role, subject, displayName }) => {
      try {
        return ok(await keyring.grantRole({ role, subject, displayName }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.tool(
    "revoke_role",
    "Revoke a role from a subject (removes their access to its actions). Requires the `grants.write` scope.",
    RevokeRoleSchema,
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async ({ role, subject }) => {
      try {
        return ok(await keyring.revokeRole({ role, subject }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.tool(
    "replace_role",
    "Move a subject from one role to another: grants `to`, then revokes `from`. Requires the `grants.write` scope.",
    ReplaceRoleSchema,
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async ({ subject, from, to, displayName }) => {
      try {
        await keyring.replaceRole({ subject, from, to, displayName });
        return ok({ ok: true, subject, from, to });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.tool(
    "create_role",
    "Create (or update) a role and optionally attach existing actions to it. Requires the `roles.write` scope. Create actions first — unknown action slugs fail with no partial write.",
    CreateRoleSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ slug, name, description, permissions }) => {
      try {
        return ok(await keyring.createRole({ slug, name, description, permissions }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.tool(
    "create_action",
    "Create (or update) an action (permission) in the active workspace. Requires the `actions.write` scope.",
    CreateActionSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ slug, name, category, description }) => {
      try {
        return ok(await keyring.createPermission({ slug, name, category, description }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  server.tool(
    "create_subject_token",
    "Mint a short-lived JWT for a subject so a browser client with a publishable key can run checks as them. Requires the `subject_tokens.write` scope. Treat the token as a secret — hand it to the subject, never log it.",
    CreateSubjectTokenSchema,
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ subject, ttlSeconds }) => {
      try {
        const result = await keyring.createSubjectToken({ subject, ttlSeconds });
        return ok({ ...result, expiresAt: result.expiresAt.toISOString() });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
}
