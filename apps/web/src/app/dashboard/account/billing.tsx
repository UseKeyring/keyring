"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { useMySubscription } from "@/hooks/useBilling";
import {
  isSubscribed,
  useCustomerPortal,
  useInvalidateSubscription,
  usePolarCheckout,
} from "@/hooks/useBilling";
import { Button } from "@keyring/ui/components/button";
import {
  SettingsGroup,
  SettingsGroupItem,
} from "@keyring/ui/components/settings-group";

const PLAN_LABEL: Record<string, string> = {
  free: "Self-hosted (free)",
  pro: "Pro",
  enterprise: "Enterprise",
};

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  past_due: "Past due",
  canceled: "Canceled",
};

/*
 * Personal billing — the subscription that unlocks workspace creation on
 * this hosted console. Self-hosters have no row (free). Portal manages or
 * cancels; checkout subscribes.
 */
export function BillingSection() {
  const subscription = useMySubscription();
  const checkout = usePolarCheckout();
  const portal = useCustomerPortal();

  const sub = subscription.data;
  const subscribed = isSubscribed(sub);
  const invalidateSubscription = useInvalidateSubscription();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "success") {
      toast.success("Payment received — confirming your subscription…");
      invalidateSubscription();
      const url = new URL(window.location.href);
      url.searchParams.delete("checkout");
      url.searchParams.delete("checkout_id");
      window.history.replaceState(null, "", url.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="type-body-lg font-medium text-ink">Billing</h2>
        <p className="type-body-sm mt-1 text-ink-muted">
          Creating a workspace on this hosted console requires an active Pro
          or Enterprise subscription. Self-hosting stays free forever.
        </p>
      </div>

      <SettingsGroup>
        <SettingsGroupItem
          title="Plan"
          description={
            sub
              ? `Status: ${STATUS_LABEL[sub.status] ?? sub.status}${
                  sub.cancel_at_period_end ? " — cancels at period end" : ""
                }`
              : "No subscription — self-hosted tier"
          }
        >
          <span className="type-body-sm text-ink">
            {sub ? (PLAN_LABEL[sub.plan] ?? sub.plan) : "—"}
          </span>
        </SettingsGroupItem>
        <SettingsGroupItem
          title={subscribed ? "Manage subscription" : "Subscribe"}
          description={
            subscribed
              ? "Update payment method, view invoices or cancel via Polar."
              : "Pro is $12 per project / month. Enterprise is sales-led."
          }
        >
          <div className="flex flex-col items-end gap-2">
            {(checkout.error || portal.error) && (
              <p className="type-body-sm text-red-500">{checkout.error ?? portal.error}</p>
            )}
            <div className="flex gap-2">
              {!subscribed && (
                <Button
                  type="button"
                  disabled={checkout.loading}
                  onClick={() => void checkout.startCheckout("/dashboard/account")}
                >
                  {checkout.loading ? "Opening checkout…" : "Subscribe to Pro"}
                </Button>
              )}
              {sub?.provider_customer_id && (
                <Button
                  type="button"
                  variant={subscribed ? "secondary" : "ghost"}
                  disabled={portal.loading}
                  onClick={() => void portal.openPortal()}
                >
                  {portal.loading ? "Opening…" : "Manage billing"}
                </Button>
              )}
            </div>
          </div>
        </SettingsGroupItem>
      </SettingsGroup>
    </div>
  );
}
