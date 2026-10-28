import type { Metadata } from "next";
import { SignInIllustration } from "../illustrations";
import { AsciiPage, Row } from "../ascii-shell";
import { AuthForm } from "./auth-form";

export const metadata: Metadata = {
  title: "Sign in — Keyring",
  description: "Sign in or create your Keyring workspace account.",
};

export default function AuthPage() {
  return (
    <AsciiPage>
      <Row>
        <div className="cells grid lg:grid-cols-2" style={{ minHeight: "calc(100vh - 64px)" }}>
          <div className="pad" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
            <AuthForm />
          </div>
          <div className="grid-bg hidden lg:flex" style={{ alignItems: "center", justifyContent: "center", padding: "32px 12px" }}>
            <SignInIllustration />
          </div>
        </div>
      </Row>
    </AsciiPage>
  );
}
