import { SignJWT, jwtVerify } from "jose";

const ISSUER = "keyring";
const HEADER = "x-keyring-subject-token";

export const SUBJECT_TOKEN_HEADER = HEADER;

const DEFAULT_TTL_SECONDS = 3600;
const MAX_TTL_SECONDS = 86_400;

export type SubjectTokenClaims = {
  subject: string;
  organizationId: string;
  expiresAt: Date;
};

function signingKey(): Uint8Array {
  const secret =
    process.env["SUBJECT_TOKEN_SECRET"] ?? process.env["KEYRING_SUBJECT_TOKEN_SECRET"] ?? "";
  if (!secret) {
    throw new Error("SUBJECT_TOKEN_SECRET is not configured");
  }
  return new TextEncoder().encode(secret);
}

export function clampTtlSeconds(ttl?: number | null): number {
  if (ttl == null || !Number.isFinite(ttl)) return DEFAULT_TTL_SECONDS;
  const n = Math.floor(ttl);
  if (n < 60) return 60;
  if (n > MAX_TTL_SECONDS) return MAX_TTL_SECONDS;
  return n;
}

export async function mintSubjectToken(input: {
  subject: string;
  organizationId: string;
  ttlSeconds?: number | null;
}): Promise<{ token: string; subject: string; expiresAt: Date }> {
  const ttl = clampTtlSeconds(input.ttlSeconds);
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = await new SignJWT({
    org: input.organizationId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.subject)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(signingKey());

  return { token, subject: input.subject, expiresAt };
}

export async function verifySubjectToken(
  token: string,
  expectedOrganizationId: string,
): Promise<SubjectTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: ISSUER,
      algorithms: ["HS256"],
    });
    const subject = typeof payload.sub === "string" ? payload.sub : "";
    const org = typeof payload["org"] === "string" ? payload["org"] : "";
    if (!subject || !org) return null;
    if (org !== expectedOrganizationId) return null;
    if (!payload.exp) return null;
    return {
      subject,
      organizationId: org,
      expiresAt: new Date(payload.exp * 1000),
    };
  } catch {
    return null;
  }
}

export function readSubjectTokenHeader(req: Request): string | null {
  const value = req.headers.get(HEADER)?.trim() ?? "";
  return value.length > 0 ? value : null;
}
