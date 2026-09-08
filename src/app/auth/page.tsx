import type { Metadata } from "next";
import { AuthForm } from "./auth-form";
import { SiteNav } from "../site-nav";

export const metadata: Metadata = {
  title: "Sign in — Keyring",
  description: "Sign in or create your Keyring workspace account.",
};

export default function AuthPage() {
  return (
    <main className="min-h-screen bg-canvas">
      <SiteNav />
      <AuthForm />
    </main>
  );
}
