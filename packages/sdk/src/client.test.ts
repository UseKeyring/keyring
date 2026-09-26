import { describe, expect, test } from "bun:test";
import { Keyring } from "./client.js";
import { ForbiddenError, UnauthorizedError } from "./errors.js";
import { SUBJECT_TOKEN_HEADER } from "./http.js";

type Captured = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

function mockFetch(handler: (req: Captured) => { status: number; body: unknown }) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const raw = new Headers(init?.headers);
    raw.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const captured: Captured = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    const result = handler(captured);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("Keyring SDK", () => {
  test("secret check sends subject query and bearer", async () => {
    let captured: Captured | null = null;
    const keyring = new Keyring({
      apiKey: "kr_sk_live_test",
      baseUrl: "https://keyring.example",
      fetch: mockFetch((req) => {
        captured = req;
        return {
          status: 200,
          body: { subject: "user_1", permission: "invoices.refund", allowed: true },
        };
      }),
    });

    const result = await keyring.check("user_1", "invoices.refund");
    expect(result.allowed).toBe(true);
    expect(captured?.method).toBe("GET");
    expect(captured?.headers["authorization"]).toBe("Bearer kr_sk_live_test");
    expect(captured?.url).toContain("subject=user_1");
    expect(captured?.url).toContain("permission=invoices.refund");
  });

  test("publishable check sends subject token header and omits forgeable subject", async () => {
    let captured: Captured | null = null;
    const keyring = new Keyring({
      apiKey: "kr_pk_live_test",
      baseUrl: "https://keyring.example/",
      subjectToken: "jwt-token",
      fetch: mockFetch((req) => {
        captured = req;
        return {
          status: 200,
          body: { subject: "user_1", permission: "docs.read", allowed: false },
        };
      }),
    });

    const result = await keyring.check("docs.read");
    expect(result.allowed).toBe(false);
    expect(captured?.headers[SUBJECT_TOKEN_HEADER.toLowerCase()]).toBe("jwt-token");
    expect(captured?.url).toContain("permission=docs.read");
    expect(captured?.url).not.toContain("subject=");
  });

  test("publishable key cannot grant", async () => {
    const keyring = new Keyring({
      apiKey: "kr_pk_live_test",
      baseUrl: "https://keyring.example",
      fetch: mockFetch(() => ({ status: 200, body: {} })),
    });
    expect(keyring.grantRole({ role: "viewer", subject: "user_1" })).rejects.toThrow(
      /cannot grant/,
    );
  });

  test("grant maps displayName to display_name", async () => {
    let captured: Captured | null = null;
    const keyring = new Keyring({
      apiKey: "kr_sk_live_test",
      baseUrl: "https://keyring.example",
      fetch: mockFetch((req) => {
        captured = req;
        return { status: 201, body: { ok: true, role: "viewer", subject: "user_1" } };
      }),
    });

    await keyring.grantRole({
      role: "viewer",
      subject: "user_1",
      displayName: "Ada",
    });
    expect(captured?.method).toBe("POST");
    expect(JSON.parse(captured?.body ?? "{}")).toEqual({
      role: "viewer",
      subject: "user_1",
      display_name: "Ada",
    });
  });

  test("grant forwards ttl_seconds and expires_at", async () => {
    let captured: Captured | null = null;
    const keyring = new Keyring({
      apiKey: "kr_sk_live_test",
      baseUrl: "https://keyring.example",
      fetch: mockFetch((req) => {
        captured = req;
        return { status: 201, body: { ok: true, role: "repo-creator", subject: "user_1" } };
      }),
    });

    await keyring.grantRole({ role: "repo-creator", subject: "user_1", ttlSeconds: 300 });
    expect(JSON.parse(captured?.body ?? "{}")).toMatchObject({
      role: "repo-creator",
      subject: "user_1",
      ttl_seconds: 300,
    });

    await keyring.grantRole({
      role: "repo-creator",
      subject: "user_1",
      expiresAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(JSON.parse(captured?.body ?? "{}")).toMatchObject({
      expires_at: "2026-01-01T00:00:00.000Z",
    });
  });

  test("maps 401 to UnauthorizedError", async () => {
    const keyring = new Keyring({
      apiKey: "kr_sk_live_test",
      baseUrl: "https://keyring.example",
      fetch: mockFetch(() => ({ status: 401, body: { error: "Unauthorized" } })),
    });
    expect(keyring.listRoles()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("assert throws ForbiddenError when denied", async () => {
    const keyring = new Keyring({
      apiKey: "kr_sk_live_test",
      baseUrl: "https://keyring.example",
      fetch: mockFetch(() => ({
        status: 200,
        body: { subject: "user_1", permission: "x", allowed: false },
      })),
    });
    expect(keyring.assert("user_1", "x")).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("createSubjectToken posts ttl_seconds", async () => {
    let captured: Captured | null = null;
    const keyring = new Keyring({
      apiKey: "kr_sk_live_test",
      baseUrl: "https://keyring.example",
      fetch: mockFetch((req) => {
        captured = req;
        return {
          status: 200,
          body: {
            token: "jwt",
            subject: "user_1",
            expires_at: "2026-01-01T00:00:00.000Z",
          },
        };
      }),
    });
    const minted = await keyring.createSubjectToken({
      subject: "user_1",
      ttlSeconds: 120,
    });
    expect(minted.token).toBe("jwt");
    expect(minted.expiresAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(JSON.parse(captured?.body ?? "{}")).toEqual({
      subject: "user_1",
      ttl_seconds: 120,
    });
  });

  test("track posts custom event", async () => {
    let captured: Captured | null = null;
    const keyring = new Keyring({
      apiKey: "kr_sk_live_test",
      baseUrl: "https://keyring.example",
      fetch: mockFetch((req) => {
        captured = req;
        return { status: 201, body: { ok: true, id: "evt_1" } };
      }),
    });
    const result = await keyring.track("user_1", "invoices.refund", {
      allowed: true,
      context: { source: "test" },
    });
    expect(result.id).toBe("evt_1");
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toContain("/api/v1/events");
    expect(JSON.parse(captured?.body ?? "{}")).toEqual({
      subject: "user_1",
      permission: "invoices.refund",
      allowed: true,
      context: { source: "test" },
    });
  });

  test("publishable key cannot track", async () => {
    const keyring = new Keyring({
      apiKey: "kr_pk_live_test",
      baseUrl: "https://keyring.example",
      fetch: mockFetch(() => ({ status: 201, body: {} })),
    });
    expect(keyring.track("user_1", "x")).rejects.toThrow(/cannot track/);
  });

  test("createRole posts to /api/v1/roles", async () => {
    let captured: Captured | null = null;
    const keyring = new Keyring({
      apiKey: "kr_sk_live_test",
      baseUrl: "https://keyring.example",
      fetch: mockFetch((req) => {
        captured = req;
        return {
          status: 201,
          body: { slug: "player", name: "Player", description: null, created_at: "2026-01-01T00:00:00Z" },
        };
      }),
    });
    const role = await keyring.createRole({
      slug: "player",
      name: "Player",
      permissions: ["games.play", "games.create"],
    });
    expect(role.slug).toBe("player");
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toContain("/api/v1/roles");
    expect(JSON.parse(captured?.body ?? "{}")).toMatchObject({
      slug: "player",
      permissions: ["games.play", "games.create"],
    });
  });

  test("createPermission posts to /api/v1/permissions", async () => {
    let captured: Captured | null = null;
    const keyring = new Keyring({
      apiKey: "kr_sk_live_test",
      baseUrl: "https://keyring.example",
      fetch: mockFetch((req) => {
        captured = req;
        return {
          status: 201,
          body: { slug: "games.play", name: "Play games", description: null, category: "Games", created_at: "2026-01-01T00:00:00Z" },
        };
      }),
    });
    const perm = await keyring.createPermission({ slug: "games.play", name: "Play games" });
    expect(perm.slug).toBe("games.play");
    expect(captured?.method).toBe("POST");
    expect(captured?.url).toContain("/api/v1/permissions");
  });

  test("publishable key cannot create roles or actions", async () => {
    const keyring = new Keyring({
      apiKey: "kr_pk_live_test",
      baseUrl: "https://keyring.example",
      fetch: mockFetch(() => ({ status: 201, body: {} })),
    });
    expect(keyring.createRole({ slug: "player", name: "Player" })).rejects.toThrow(/cannot create/);
    expect(keyring.createPermission({ slug: "games.play", name: "Play" })).rejects.toThrow(/cannot create/);
  });
});
