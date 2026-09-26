import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Keyring } from "@usekeyring/sdk";
import { createServer } from "./server.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Full mock: inspects method + body from the init param.
function apiMock(statusForCheck = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body != null ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    return route(url, method, body, statusForCheck);
  }) as typeof fetch;
}

function route(url: URL, method: string, body: Record<string, unknown>, statusForCheck: number): Response {
  if (url.pathname === "/api/v1/check") {
    if (statusForCheck !== 200) return jsonResponse({ error: "missing scope: check" }, statusForCheck);
    return jsonResponse({
      subject: url.searchParams.get("subject"),
      permission: url.searchParams.get("permission"),
      allowed: true,
    });
  }
  if (url.pathname === "/api/v1/roles") {
    if (method === "POST") {
      return jsonResponse({ slug: body["slug"], name: body["name"], description: null, created_at: "2026-01-01T00:00:00Z" }, 201);
    }
    return jsonResponse({ roles: [{ slug: "support", name: "Support", description: null, created_at: "2026-01-01T00:00:00Z" }] });
  }
  if (url.pathname === "/api/v1/permissions") {
    if (method === "POST") {
      return jsonResponse({ slug: body["slug"], name: body["name"], description: null, category: "General", created_at: "2026-01-01T00:00:00Z" }, 201);
    }
    return jsonResponse({ permissions: [{ slug: "invoices.refund", name: "Refund", description: null, category: "invoices", created_at: "2026-01-01T00:00:00Z" }] });
  }
  if (url.pathname === "/api/v1/grants" && method === "POST") {
    return jsonResponse({ ok: true, role: body["role"], subject: body["subject"] });
  }
  if (url.pathname === "/api/v1/grants" && method === "DELETE") {
    return jsonResponse({ ok: true, revoked: true });
  }
  if (url.pathname === "/api/v1/subject-tokens") {
    return jsonResponse({ token: "tok_test", subject: body["subject"], expires_at: "2026-01-01T01:00:00Z" });
  }
  return jsonResponse({ error: "not found" }, 404);
}

async function connectedClient(fetchImpl: typeof fetch): Promise<Client> {
  const keyring = new Keyring({ apiKey: "kr_sk_live_test", baseUrl: "https://keyring.test", fetch: fetchImpl });
  const server = createServer(keyring);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content[0]?.text ?? "";
}

describe("keyring-mcp", () => {
  test("exposes all nine tools", async () => {
    const client = await connectedClient(apiMock());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["check_access", "create_action", "create_role", "create_subject_token", "grant_role", "list_actions", "list_roles", "replace_role", "revoke_role"].sort(),
    );
    await client.close();
  });

  test("check_access returns the decision", async () => {
    const client = await connectedClient(apiMock());
    const result = await client.callTool({
      name: "check_access",
      arguments: { subject: "user_123", permission: "invoices.refund" },
    });
    expect(JSON.parse(textOf(result))).toEqual({ subject: "user_123", permission: "invoices.refund", allowed: true });
    await client.close();
  });

  test("grant → replace → revoke flow", async () => {
    const client = await connectedClient(apiMock());
    const granted = await client.callTool({ name: "grant_role", arguments: { role: "support", subject: "user_123" } });
    expect(JSON.parse(textOf(granted))).toMatchObject({ ok: true, role: "support", subject: "user_123" });

    const replaced = await client.callTool({
      name: "replace_role",
      arguments: { subject: "user_123", from: "support", to: "finance" },
    });
    expect(JSON.parse(textOf(replaced))).toMatchObject({ ok: true, from: "support", to: "finance" });

    const revoked = await client.callTool({ name: "revoke_role", arguments: { role: "finance", subject: "user_123" } });
    expect(JSON.parse(textOf(revoked))).toEqual({ ok: true, revoked: true });
    await client.close();
  });

  test("list_roles, list_actions and create_subject_token", async () => {
    const client = await connectedClient(apiMock());
    const roles = await client.callTool({ name: "list_roles", arguments: {} });
    expect(JSON.parse(textOf(roles)).roles[0].slug).toBe("support");

    const actions = await client.callTool({ name: "list_actions", arguments: {} });
    expect(JSON.parse(textOf(actions)).actions[0].slug).toBe("invoices.refund");

    const token = await client.callTool({ name: "create_subject_token", arguments: { subject: "user_123" } });
    expect(JSON.parse(textOf(token))).toMatchObject({ token: "tok_test", subject: "user_123" });
    await client.close();
  });

  test("create_role and create_action", async () => {
    const client = await connectedClient(apiMock());
    const role = await client.callTool({
      name: "create_role",
      arguments: { slug: "player", name: "Player", permissions: ["games.play"] },
    });
    expect(JSON.parse(textOf(role))).toMatchObject({ slug: "player", name: "Player" });

    const action = await client.callTool({
      name: "create_action",
      arguments: { slug: "games.play", name: "Play games" },
    });
    expect(JSON.parse(textOf(action))).toMatchObject({ slug: "games.play" });
    await client.close();
  });

  test("API errors surface as tool errors with scope hints", async () => {
    const client = await connectedClient(apiMock(403));
    const result = await client.callTool({
      name: "check_access",
      arguments: { subject: "user_123", permission: "invoices.refund" },
    });
    const flagged = result as { isError?: boolean };
    expect(flagged.isError).toBe(true);
    expect(textOf(result)).toContain("403");
    await client.close();
  });

  test("invalid arguments are rejected", async () => {
    const client = await connectedClient(apiMock());
    const result = (await client.callTool({
      name: "grant_role",
      arguments: { role: "support" },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    await client.close();
  });
});
