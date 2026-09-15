"use client";

import { AccountSection } from "../[orgSlug]/settings/account";
import { BillingSection } from "./billing";

export default function AccountPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-medium whitespace-nowrap text-ink">Account settings</h1>
        <p className="type-body-sm mt-1 text-ink-muted">
          Your personal sign-in and profile. For workspace identity, API keys and danger
          zone, head to workspace settings.
        </p>
      </div>

      <AccountSection />
      <BillingSection />
    </div>
  );
}
