import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SiteWordmark } from "../site-nav";
import { ThemeToggle } from "../theme-toggle";
import { WaitlistForm } from "../waitlist-form";
import { isWaitlistEnabled } from "@/lib/waitlist";

export const metadata: Metadata = {
  title: "Join the waitlist — Keyring",
  description:
    "Leave your email for Keyring early access. Approved emails can sign in while the waitlist is on.",
};

// Runtime toggle (WAITLIST) needs per-request rendering so the page can
// bounce to / once the beta is over.
export const dynamic = "force-dynamic";

export default function WaitlistPage() {
  if (!isWaitlistEnabled()) redirect("/");
  return (
    <main className="flex min-h-screen flex-col bg-canvas">
      <div className="w-full">
        <nav className="mx-auto flex h-16 w-full max-w-[1920px] items-center justify-between px-5 md:px-12">
          <SiteWordmark />
          <ThemeToggle />
        </nav>
      </div>

      <div className="flex flex-1 items-center px-5 py-16 md:px-12 md:py-24">
        <WaitlistForm />
      </div>

      <div className="w-full border-t border-hairline">
        <div className="mx-auto flex w-full max-w-[1920px] items-center justify-between px-5 py-8 md:px-12">
          <SiteWordmark />
          <p className="type-body-sm text-ink-muted">
            &copy; Keyring {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </main>
  );
}
