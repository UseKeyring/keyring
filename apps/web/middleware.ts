import { type NextRequest, NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function middleware(request: NextRequest) {
  // Private beta: while the waitlist is on, marketing routes beyond the
  // landing have no public content — bounce them to /waitlist before any
  // session work. Covers direct URL entry, not just hidden nav links.
  const waitlistRaw = (
    process.env["NEXT_PUBLIC_WAITLIST"] ??
    process.env["WAITLIST"] ??
    ""
  ).toLowerCase();
  const waitlistOn =
    waitlistRaw === "true" || waitlistRaw === "1" || waitlistRaw === "yes";
  if (waitlistOn) {
    const { pathname } = request.nextUrl;
    if (pathname === "/pricing" || pathname.startsWith("/pricing/")) {
      const url = request.nextUrl.clone();
      url.pathname = "/waitlist";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  const response = NextResponse.next({ request });
  // Env precedence is unified across middleware, server clients, and the
  // browser client: NEXT_PUBLIC_* first so every layer resolves to the same
  // project when both prefixed and unprefixed vars are set (preview envs).
  // The browser can only see NEXT_PUBLIC_*, so servers must match it.
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? process.env["SUPABASE_URL"] ?? "";
  const key =
    process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ??
    process.env["SUPABASE_PUBLISHABLE_KEY"] ??
    "";
  if (!url || !key) return response;
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });
  // Fail open: session refresh must never wedge page loads or client-side
  // navigations (this runs on every request, including RSC transitions).
  // Auth is still enforced by Supabase RLS on every query.
  try {
    await Promise.race([
      supabase.auth.getUser(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("supabase getUser timed out")), 5000),
      ),
    ]);
  } catch (e) {
    console.warn("[middleware] session refresh skipped:", e);
  }
  return response;
}

export const config = {
  // API-key-authed management routes don't use the session — skip the
  // per-request getUser round-trip there.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|api/v1/.*|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
