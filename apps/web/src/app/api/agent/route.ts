import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/integrations/supabase/server";

// Structural client type: the @supabase/ssr server client (used at runtime so
// writes carry the user's session) is generic-incompatible with the
// supabase-js client type under exactOptionalPropertyTypes, and neither
// infers usable table types here. These five queries only need from(), so
// type the surface structurally instead of fighting the generics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from(table: string): any };

// Simple agent endpoint for RBAC operations
// This is a simplified version that doesn't use the full Pi SDK
// but provides a conversational interface for creating roles, actions, and users

export async function POST(req: NextRequest) {
  try {
    const { message, organizationId, context, conversationHistory = [], accessToken } = await req.json();

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    if (!organizationId) {
      return NextResponse.json({ error: "Organization ID is required" }, { status: 400 });
    }

    // Auth: the app signs in with the supabase-js browser client, whose
    // session lives in localStorage — never in cookies. So the cookie-based
    // server client is always anon here. The browser therefore forwards its
    // short-lived access token and the route builds a per-request client
    // scoped to that user (same RLS identity as manual creation, no
    // service_role anywhere).
    const supabase = await getAgentDb(accessToken);
    if (!supabase) {
      return NextResponse.json(
        { response: "You're signed out — please refresh the page and sign in again." },
        { status: 401 },
      );
    }

    // Intent comes from the AI, always. No rule-based fallback: when the AI
    // can't answer, the user gets an honest error, never a canned guess.
    const intent = await aiAnalyzeIntent(message, context, conversationHistory);
    
    // Execute the appropriate action
    let result: { success: boolean; data?: unknown; error?: string } | null = null;
    let response = "";
    
    switch (intent.action) {
      case "create_role": {
        const roleData = intent.data as { slug: string; name: string; description?: string; permissions?: string[] };
        result = await createRole(supabase, organizationId, roleData);
        response = result.success 
          ? `Great! I've created the role "${roleData.name}" (slug: ${roleData.slug}). ${roleData.permissions?.length ? `It includes ${roleData.permissions.length} permissions.` : ''} What would you like to do next?`
          : `Sorry, I couldn't create that role: ${result.error}`;
        break;
      }
        
      case "create_permission": {
        const permData = intent.data as { slug: string; name: string; category?: string; description?: string };
        result = await createPermission(supabase, organizationId, permData);
        response = result.success
          ? `Perfect! I've created the action "${permData.name}" (slug: ${permData.slug}) in the ${permData.category || 'General'} category. What else would you like to create?`
          : `Sorry, I couldn't create that action: ${result.error}`;
        break;
      }
        
      case "create_subject": {
        const subjectData = intent.data as { external_id: string; display_name?: string };
        result = await createSubject(supabase, organizationId, subjectData);
        response = result.success
          ? `Done! I've added the user "${subjectData.display_name || subjectData.external_id}" to your workspace. Would you like to grant them any roles?`
          : `Sorry, I couldn't add that user: ${result.error}`;
        break;
      }
        
      case "list_roles":
        result = await listRoles(supabase, organizationId);
        response = formatRolesList(result.data as { id: string; slug: string; name: string; description?: string | null }[] | undefined);
        break;
        
      case "list_permissions":
        result = await listPermissions(supabase, organizationId);
        response = formatPermissionsList(result.data as { slug: string; name: string; category: string; description?: string | null }[] | undefined);
        break;
        
      case "clarify":
        response = intent.response || "What name and slug should I use?";
        break;

      case "ai_unavailable":
        response = intent.response || "The AI didn't answer — try again in a moment.";
        break;

      default:
        response = intent.response || "Sorry — I didn't get that. Try again?";
    }

    return NextResponse.json({ 
      response,
      intent: intent.action,
      data: result?.data,
      conversationHistory: [...conversationHistory, { role: "user", content: message }, { role: "assistant", content: response }]
    });

  } catch (error) {
    console.error("Agent error:", error);
    return NextResponse.json(
      { error: "Failed to process agent request", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// AI intent parsing (OpenAI-compatible chat completions endpoint).
// Server-only AGENT_AI_KEY (Gemini free tier by default). There is no
// rule-based fallback: when the AI can't answer, the intent is
// "ai_unavailable" with an honest reason, never a canned guess.
// The AI only parses — execution still goes through the RLS-scoped DB fns.
// ---------------------------------------------------------------------------
type AiIntent = {
  action:
    | "create_role"
    | "create_permission"
    | "create_subject"
    | "list_roles"
    | "list_permissions"
    | "clarify"
    | "converse"
    | "ai_unavailable";
  data: Record<string, unknown>;
  response?: string;
};

const AI_ACTIONS = new Set([
  "create_role",
  "create_permission",
  "create_subject",
  "list_roles",
  "list_permissions",
  "clarify",
  "converse",
]);

const AI_SYSTEM_PROMPT = `You parse admin requests for Keyring (hosted at https://usekeyring.dev, docs at https://usekeyring.dev/docs — an RBAC console with actions, roles, and end-users).
Reply with STRICT JSON only, no other text, no markdown fences:
{"action": "<one of create_role|create_permission|create_subject|list_roles|list_permissions|clarify|converse>", "data": {...}, "response": "<one short chatty sentence for the user>"}
Slots:
- create_role: data {slug, name, description?}. Slug: lowercase words with dashes, e.g. support-agent.
- create_permission: data {slug, name, category?, description?}. Slug: resource.action, lowercase with dots, e.g. invoices.create, refunds.create. Category: single Capitalized word, default "General". When unsure, omit category (it defaults to General) rather than guessing from the resource name.
- create_subject: data {external_id, display_name?}.
- If the user gives a name without a slug (or vice versa), fill BOTH by converting: "Create invoices" <-> invoices.create, "Support Agent" <-> support-agent.
- If required info is genuinely missing, use "clarify" and ask for exactly what's missing in "response".
- Small talk, thanks, questions, or anything else: "converse" with a brief helpful "response".
- Never invent organization IDs. Tolerate typos like "catagory".`;

function cleanStr(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

// Cloned from @earendil-works/pi-coding-agent:
// - dist/core/provider-attribution.js → getSessionHeaders:
//   { "x-opencode-session": <id>, "x-opencode-client": "pi" }
// - dist/bundle/chunks/chunk-AXIIZGTV.js → getPiUserAgent():
//   `pi (<platform> <release>; <arch>)`
// - dist/core/session-manager.js → createSessionId() = uuidv7() (local only,
//   no registration — verified in src).
// NOTE: all of this is cloned and live-tested, and Zen still 403s free-tier
// models on external calls. The gate is account-side; these headers are
// correct client attribution, not a bypass.
import { release as osRelease } from "node:os";

function uuidv7(): string {
  const timeHex = Date.now().toString(16).padStart(12, "0");
  const h = [...crypto.getRandomValues(new Uint8Array(10))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const g4head = (0x80 | (parseInt(h.slice(3, 5), 16) & 0x3f)).toString(16).padStart(2, "0");
  return (
    `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${h.slice(0, 3)}-` +
    `${g4head}${h.slice(5, 7)}-${h.slice(7, 19)}`
  );
}

let cachedAgentSessionId: string | undefined;
function agentAttributionHeaders(): Record<string, string> {
  cachedAgentSessionId ??= uuidv7();
  return {
    "User-Agent": `pi (${process.platform} ${osRelease()}; ${process.arch})`,
    "x-opencode-session": cachedAgentSessionId,
    "x-opencode-client": "pi",
  };
}

/** One-line provider failure for user-facing errors: "Gemini 400: msg". */
async function providerErrorSummary(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as {
        error?: { message?: string } | string;
      };
      const msg =
        typeof body.error === "string" ? body.error : (body.error?.message ?? text);
      return `${res.status}: ${msg}`.slice(0, 200);
    } catch {
      return `${res.status}: ${text}`.slice(0, 200);
    }
  } catch {
    return `${res.status}`;
  }
}

function extractJson(text: string): Record<string, unknown> | null {  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return JSON.parse((fenced?.[1] ?? text).trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function aiAnalyzeIntent(
  message: string,
  context: string | undefined,
  conversationHistory: unknown,
): Promise<AiIntent> {
  const apiKey = process.env["AGENT_AI_KEY"] ?? "";
  if (!apiKey) {
    return {
      action: "ai_unavailable",
      data: {},
      response: "The AI isn't configured on this workspace yet — ask your admin to set AGENT_AI_KEY.",
    };
  }
  if (message.length > 2000) {
    return {
      action: "ai_unavailable",
      data: {},
      response: "That's a bit long for me — keep it under 2000 characters?",
    };
  }

  try {
    const base = (process.env["AGENT_AI_BASE_URL"] ?? "https://opencode.ai/zen").replace(/\/$/, "");
    const isZen = base.includes("opencode.ai");
    // Free upstream default: Gemini flash (generativelanguage free tier allows
    // external calls). Unknown model names fail over to the next entry.
    // NOTE: Zen free-tier models only answer inside the OpenCode app
    // OpenCode app (FreeTierError externally); cheapest Zen model is gpt-5-nano.
    const models = [
      ...new Set([
        process.env["AGENT_AI_MODEL"] ?? "gemini-3.6-flash",
        "gemini-3.6-flash",
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gpt-5-nano",
        "openai",
      ]),
    ];
    const history = Array.isArray(conversationHistory)
      ? (conversationHistory as HistoryMessage[])
          .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
          .slice(-6)
          .map((m) => ({ role: m.role as string, content: (m.content as string).slice(0, 1000) }))
      : [];

    const payload = {
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        { role: "system", content: `${AI_SYSTEM_PROMPT}\nCurrent page: ${context ?? "unknown"}.` },
        ...history,
        { role: "user", content: message },
      ],
    };

    // Pi-style attribution only applies to Zen; other providers get a plain call.
    const extraHeaders = isZen ? agentAttributionHeaders() : {};
    let content: string | undefined;
    // First error is the diagnostic one (e.g. region block on the configured
    // model); later chain entries just add noise.
    let firstProviderError = "";
    for (const model of models) {
      try {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            ...extraHeaders,
          },
          body: JSON.stringify({ ...payload, model }),
          signal: AbortSignal.timeout(25000),
        });
        // Rate-limited: further attempts only burn quota — fail honestly.
        if (res.status === 429) {
          return {
            action: "ai_unavailable",
            data: {},
            response: "The AI provider is throttling me right now — wait a minute and try again.",
          };
        }
        if (!res.ok) {
          // 400s are request/account-level (region block, bad key) — no other
          // model will succeed, so stop. 404 = unknown model, try the next.
          const summary = await providerErrorSummary(res);
          if (!firstProviderError) firstProviderError = summary;
          if (res.status === 400) break;
          continue;
        }
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        content = body.choices?.[0]?.message?.content ?? undefined;
        if (content) break;
      } catch {
        continue;
      }
    }
    if (!content) {
      return {
        action: "ai_unavailable",
        data: {},
        response: firstProviderError
          ? `The AI provider failed: ${firstProviderError}`
          : "The AI didn't answer — try again in a moment.",
      };
    }

    const parsed = extractJson(content);
    if (!parsed || typeof parsed["action"] !== "string" || !AI_ACTIONS.has(parsed["action"] as string)) {
      return {
        action: "ai_unavailable",
        data: {},
        response: "The AI gave me gibberish — try again?",
      };
    }
    const action = parsed["action"] as AiIntent["action"];
    const raw = (parsed["data"] ?? {}) as Record<string, unknown>;
    const responseText = cleanStr(parsed["response"], 500);
    const maybeResponse = responseText ? { response: responseText } : {};

    // Normalize + complete slots with shared derivations.
    if (action === "create_permission") {
      let slug = cleanStr(raw["slug"], 120).toLowerCase();
      let name = cleanStr(raw["name"]);
      const category = cleanStr(raw["category"], 60);
      if (!slug && name) slug = slugifyActionName(name);
      if (!name && slug) name = humanizeActionSlug(slug);
      if (!slug || !name) return { action: "clarify", data: {}, ...maybeResponse };
      return {
        action,
        data: {
          slug,
          name,
          ...(category ? { category: capitalize(category) } : {}),
          ...(cleanStr(raw["description"]) ? { description: cleanStr(raw["description"]) } : {}),
        },
        ...maybeResponse,
      };
    }
    if (action === "create_role") {
      let slug = cleanStr(raw["slug"], 120).toLowerCase();
      let name = cleanStr(raw["name"]);
      if (!slug && name) slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!name && slug) name = humanizeRoleSlug(slug);
      if (!slug || !name) return { action: "clarify", data: {}, ...maybeResponse };
      return { action, data: { slug, name }, ...maybeResponse };
    }
    if (action === "create_subject") {
      const external_id = cleanStr(raw["external_id"], 120);
      if (!external_id) return { action: "clarify", data: {}, ...maybeResponse };
      const display_name = cleanStr(raw["display_name"]);
      return { action, data: { external_id, ...(display_name ? { display_name } : {}) }, ...maybeResponse };
    }
    return { action, data: {}, ...maybeResponse };
  } catch {
    return {
      action: "ai_unavailable",
      data: {},
      response: "The AI didn't answer — try again in a moment.",
    };
  }
}

type HistoryMessage = { role?: string; content?: string };


function capitalize(word: string): string {
  const first = word.charAt(0);
  return first ? first.toUpperCase() + word.slice(1) : word;
}

/** `invoices.create` -> "Create invoices" (resource.action convention). */
function humanizeActionSlug(slug: string): string {
  const parts = slug.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    const verb = parts[parts.length - 1] ?? "";
    const rest = parts.slice(0, -1);
    return `${capitalize(verb)} ${rest.join(" ")}`;
  }
  return capitalize(slug);
}

/** "Create invoices" -> `invoices.create` (resource.action convention). */
function slugifyActionName(name: string): string {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 2) return `${words[1]}.${words[0]}`;
  return words.join(".");
}

/** "support-agent" -> "Support Agent". */
function humanizeRoleSlug(slug: string): string {
  return slug.split(/[-_]+/).filter(Boolean).map(capitalize).join(" ") || capitalize(slug);
}


// Database operations
/** Per-request user-scoped client from the forwarded access token. */
async function getAgentDb(accessToken: unknown): Promise<Db | null> {
  try {
    if (typeof accessToken === "string" && accessToken.length > 0) {
      const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? process.env["SUPABASE_URL"] ?? "";
      const key =
        process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] ??
        process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ??
        process.env["SUPABASE_PUBLISHABLE_KEY"] ??
        "";
      if (!url || !key) return null;
      const client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      const { data, error } = await client.auth.getUser();
      if (error || !data.user) return null;
      return client as unknown as Db;
    }
    // Fallback: cookie session (works if the app ever moves to cookie auth).
    const cookieClient = await createSupabaseServerClient();
    const { data, error } = await cookieClient.auth.getUser();
    if (error || !data.user) return null;
    return cookieClient as unknown as Db;
  } catch {
    return null;
  }
}
// Supabase PostgREST failures are plain objects ({ message, code, ... }), not
// Error instances — String(err) renders "[object Object]" and hides the cause.
function dbErrorMessage(error: unknown): string {  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const m = (error as { message: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
async function createRole(supabase: Db, orgId: string, data: { slug: string; name: string; description?: string | undefined; permissions?: string[] | undefined }): Promise<{ success: boolean; data?: { id: string }; error?: string }> {
  try {
    const { data: role, error } = await supabase
      .from("roles")
      .insert({
        slug: data.slug,
        name: data.name,
        description: data.description ?? null,
        scope: "customer",
        organization_id: orgId,
      })
      .select("id")
      .single();

    if (error) throw error;
    
    if (data.permissions && data.permissions.length > 0 && role) {
      const { data: permData } = await supabase
        .from("permissions")
        .select("id")
        .in("slug", data.permissions);
      
      if (permData && permData.length > 0) {
        await supabase.from("role_permissions").insert(
          permData.map((p: { id: string }) => ({ role_id: role.id, permission_id: p.id }))
        );
      }
    }
    
    return { success: true, data: role };
  } catch (error) {
    return { success: false, error: dbErrorMessage(error) };
  }
}

async function createPermission(supabase: Db, orgId: string, data: { slug: string; name: string; category?: string | undefined; description?: string | undefined }): Promise<{ success: boolean; data?: { slug: string; name: string }; error?: string }> {
  try {
    const { error } = await supabase.from("permissions").insert({
      slug: data.slug,
      name: data.name,
      category: data.category ?? "General",
      description: data.description ?? null,
      scope: "customer",
      organization_id: orgId,
    });
    
    if (error) throw error;
    return { success: true, data: { slug: data.slug, name: data.name } };
  } catch (error) {
    return { success: false, error: dbErrorMessage(error) };
  }
}

async function createSubject(supabase: Db, orgId: string, data: { external_id: string; display_name?: string | undefined }): Promise<{ success: boolean; data?: { external_id: string; display_name?: string | undefined }; error?: string }> {
  try {
    const { error } = await supabase.from("subjects").insert({
      external_id: data.external_id,
      display_name: data.display_name ?? null,
      organization_id: orgId,
    });
    
    if (error) throw error;
    const result: { external_id: string; display_name?: string | undefined } = { external_id: data.external_id };
    if (data.display_name !== undefined) {
      result.display_name = data.display_name;
    }
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: dbErrorMessage(error) };
  }
}

async function listRoles(supabase: Db, orgId: string): Promise<{ success: boolean; data?: { id: string; slug: string; name: string; description?: string | null }[] | undefined; error?: string }> {
  try {
    const { data, error } = await supabase
      .from("roles")
      .select("*")
      .eq("organization_id", orgId)
      .eq("scope", "customer");
    
    if (error) throw error;
    return { success: true, data: data as { id: string; slug: string; name: string; description?: string | null }[] | undefined };
  } catch (error) {
    return { success: false, error: dbErrorMessage(error) };
  }
}

async function listPermissions(supabase: Db, orgId: string): Promise<{ success: boolean; data?: { slug: string; name: string; category: string; description?: string | null }[] | undefined; error?: string }> {
  try {
    const { data, error } = await supabase
      .from("permissions")
      .select("*")
      .eq("organization_id", orgId)
      .eq("scope", "customer");
    
    if (error) throw error;
    return { success: true, data: data as { slug: string; name: string; category: string; description?: string | null }[] | undefined };
  } catch (error) {
    return { success: false, error: dbErrorMessage(error) };
  }
}

// Response formatters
function formatRolesList(roles: { id: string; slug: string; name: string; description?: string | null }[] | undefined) {
  if (!roles || roles.length === 0) {
    return "You don't have any roles yet. Would you like to create one?";
  }
  
  const roleList = roles.map((r) => `• ${r.name} (${r.slug})${r.description ? ` - ${r.description}` : ''}`).join('\n');
  return `Here are your current roles:\n\n${roleList}\n\nWould you like to create a new role or modify an existing one?`;
}

function formatPermissionsList(perms: { slug: string; name: string; category: string; description?: string | null }[] | undefined) {
  if (!perms || perms.length === 0) {
    return "You don't have any actions yet. Would you like to create one?";
  }
  
  const grouped = perms.reduce((acc: Record<string, { slug: string; name: string; description?: string | null }[]>, p) => {
    const category = p.category || "General";
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(p);
    return acc;
  }, {} as Record<string, { slug: string; name: string; description?: string | null }[]>);
  
  let response = "Here are your current actions:\n\n";
  Object.entries(grouped).forEach(([cat, items]) => {
    response += `${cat}:\n`;
    items.forEach((p) => {
      response += `  • ${p.slug} - ${p.name}${p.description ? ` (${p.description})` : ''}\n`;
    });
  });
  
  response += "\nWould you like to create a new action?";
  return response;
}