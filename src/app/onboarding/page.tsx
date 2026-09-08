import type { Metadata } from "next";
import { OnboardingFlow } from "./onboarding-flow";

export const metadata: Metadata = {
  title: "Welcome — Keyring",
  description: "Set up your Keyring workspace organization.",
};

export default function OnboardingPage() {
  return (
    <main className="min-h-screen bg-canvas">
      <OnboardingFlow />
    </main>
  );
}
