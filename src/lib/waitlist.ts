// Waitlist (private beta) flag.
//
// Enabled when either var is truthy ("true" | "1" | "yes"):
//   NEXT_PUBLIC_WAITLIST — client-visible, set this on Vercel.
//   WAITLIST             — server-only, read in Server Components / routes.
//
// NEXT_PUBLIC_* is inlined at build time, so a runtime-only toggle needs
// WAITLIST + a dynamically rendered page (the landing page opts into that).

function raw(): string {
  return (
    process.env["NEXT_PUBLIC_WAITLIST"] ?? process.env["WAITLIST"] ?? ""
  ).toLowerCase();
}

export function isWaitlistEnabled(): boolean {
  const v = raw();
  return v === "true" || v === "1" || v === "yes";
}

export type WaitlistStatus = "pending" | "approved" | "unknown";

export function normalizeStatus(s: unknown): WaitlistStatus {
  return s === "approved" || s === "pending" ? s : "unknown";
}
