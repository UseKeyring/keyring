import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isWaitlistEnabled } from "@/lib/waitlist";
import { AsciiPage, Row } from "../ascii-shell";
import { WaitlistIllustration } from "../illustrations";
import { WaitlistForm } from "../waitlist-form";

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
    <AsciiPage waitlist>
      <Row>
        <div className="cells grid lg:grid-cols-2" style={{ minHeight: "calc(100vh - 64px)" }}>
          <div className="pad" style={{ display: "flex", alignItems: "center" }}>
            <WaitlistForm />
          </div>
          <div className="grid-bg" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 12px" }}>
            <WaitlistIllustration />
          </div>
        </div>
      </Row>
    </AsciiPage>
  );
}
