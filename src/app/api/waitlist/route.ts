import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function anonClient() {
  const url =
    process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? process.env["SUPABASE_URL"] ?? "";
  const key =
    process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"] ??
    process.env["SUPABASE_PUBLISHABLE_KEY"] ??
    "";
  if (!url || !key) throw new Error("Supabase env vars are not configured.");
  return createClient(url, key, { auth: { persistSession: false } });
}

function validEmail(email: string): boolean {
  const clean = email.trim().toLowerCase();
  return /.+@.+\..+/.test(clean) && clean.length <= 320;
}

// POST { email } — join the waitlist (idempotent, returns current status).
export async function POST(req: Request) {
  let email = "";
  try {
    const body = (await req.json()) as { email?: unknown };
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!validEmail(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  try {
    const { data, error } = await anonClient().rpc("join_waitlist", {
      _email: email,
    });
    if (error) throw error;
    const status = data === "approved" ? "approved" : "pending";
    return NextResponse.json({ status });
  } catch (e) {
    console.warn("[waitlist] join failed:", e);
    return NextResponse.json(
      { error: "Could not join the waitlist. Try again in a minute." },
      { status: 500 },
    );
  }
}

// GET ?email= — check status: pending | approved | unknown.
export async function GET(req: Request) {
  const email = new URL(req.url).searchParams.get("email")?.trim().toLowerCase() ?? "";
  if (!validEmail(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  try {
    const { data, error } = await anonClient().rpc("waitlist_status", {
      _email: email,
    });
    if (error) throw error;
    const status = data === "approved" || data === "pending" ? data : "unknown";
    return NextResponse.json({ status });
  } catch (e) {
    console.warn("[waitlist] status check failed:", e);
    return NextResponse.json(
      { error: "Could not check status. Try again in a minute." },
      { status: 500 },
    );
  }
}
