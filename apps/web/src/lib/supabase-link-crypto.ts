/**
 * Supabase CLI device-login flow, ported 1:1 from supabase/cli
 * (apps/cli/src/command-internal/ensure-login.ts +
 * command-internal/login-crypto.layer.ts).
 *
 * ECDH P-256 keypair → dashboard link carries the public key → user approves
 * → pastes the verification code → GET .../platform/cli/login/{session} →
 * AES-256-GCM decrypt (GCM tag = last 16 bytes of the ciphertext) → sbp_ token.
 *
 * Implemented on WebCrypto (subtle) instead of node:crypto so it runs on the
 * Cloudflare Workers runtime. Math is identical: deriveBits gives the same
 * 32-byte x-coordinate secret node's computeSecret returns.
 */
export const SUPABASE_API_HOST = "https://api.supabase.com";
export const SUPABASE_DASHBOARD = "https://supabase.com/dashboard";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const unhex = (s: string): Uint8Array<ArrayBuffer> => {
  if (s.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export type LinkKeypair = {
  /** Uncompressed P-256 public key hex (goes in the login URL). */
  publicKeyHex: string;
  /** PKCS#8 private key hex (stays server-side, single-use session row). */
  privateKeyHex: string;
};

export async function generateLinkKeypair(): Promise<LinkKeypair> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { publicKeyHex: hex(pubRaw), privateKeyHex: hex(privPkcs8) };
}

export function generateLinkSessionId(): string {
  return crypto.randomUUID();
}

/** Token label shown (and revocable) in the user's Supabase dashboard. */
export function defaultLinkTokenName(): string {
  return `keyring_${crypto.randomUUID().slice(0, 8)}_${Math.floor(Date.now() / 1000)}`;
}

/**
 * Login URL — query concatenated raw, no encoding, exactly like the CLI.
 * Never put the private key anywhere near here.
 */
export function buildLoginUrl(sessionId: string, tokenName: string, publicKeyHex: string): string {
  return (
    `${SUPABASE_DASHBOARD}/cli/login` +
    `?session_id=${sessionId}&token_name=${tokenName}&public_key=${publicKeyHex}`
  );
}

export type LinkSessionResponse = {
  access_token: string;
  public_key: string;
  nonce: string;
};

/** GET {apiHost}/platform/cli/login/{sessionId}?device_code=… (10s timeout, like the CLI). */
export async function fetchLoginSession(
  apiHost: string,
  sessionId: string,
  code: string,
  timeoutMs = 10000,
): Promise<LinkSessionResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${apiHost}/platform/cli/login/${sessionId}?device_code=${encodeURIComponent(code.trim())}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`verification failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    const body = (await res.json()) as Partial<LinkSessionResponse>;
    if (!body.access_token || !body.public_key || !body.nonce) {
      throw new Error("verification failed: malformed session response");
    }
    return body as LinkSessionResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** Decrypt the session's access_token with our ECDH private key. */
export async function decryptLinkToken(
  privateKeyHex: string,
  payload: LinkSessionResponse,
): Promise<string> {
  try {
    const privKey = await crypto.subtle.importKey(
      "pkcs8",
      unhex(privateKeyHex),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    const theirPub = await crypto.subtle.importKey(
      "raw",
      unhex(payload.public_key),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: theirPub }, privKey, 256);
    const aesKey = await crypto.subtle.importKey("raw", shared, "AES-GCM", false, ["decrypt"]);
    const ct = unhex(payload.access_token);
    // WebCrypto wants ciphertext+tag concatenated — exactly the CLI wire format.
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(payload.nonce) }, aesKey, ct);
    return new TextDecoder().decode(plain);
  } catch (e) {
    throw new Error(`cannot decrypt access token: ${e instanceof Error ? e.message : String(e)}`);
  }
}
