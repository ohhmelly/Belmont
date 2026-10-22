/**
 * Billing provider interface (Phase 6). Every place in the app that needs
 * to start a checkout, open a billing portal, or react to a payment
 * provider's webhook goes through this interface — never directly
 * against the `stripe` SDK — so the whole app works identically whether
 * a real Stripe test-mode account is configured or not.
 *
 * Two implementations:
 *  - `StripeProvider` (stripe-provider.ts): real Stripe, TEST MODE ONLY.
 *    Used only when `STRIPE_SECRET_KEY` is set.
 *  - `MockBillingProvider` (mock-provider.ts): the default. No network
 *    calls, no real payment processing of any kind — "checkout" flips
 *    the organization's `subscriptions` row directly so the full
 *    upgrade/downgrade flow is exercisable end to end without a Stripe
 *    account.
 *
 * See `getBillingProvider()` in index.ts for the selection logic.
 */
import type { PlanId } from "./plans";

export interface CheckoutSessionResult {
  /**
   * Where to send the user next. For `StripeProvider` this is a real
   * Stripe Checkout URL (https://checkout.stripe.com/...). For
   * `MockBillingProvider` this is an in-app URL (the billing page) —
   * the plan change has ALREADY been applied by the time this resolves,
   * since there is no external checkout step to redirect through.
   */
  url: string;
}

export interface PortalSessionResult {
  url: string;
}

export interface BillingProvider {
  readonly name: "stripe" | "mock";
  /** Start a checkout flow to move `organizationId` onto `plan`. */
  createCheckoutSession(organizationId: string, plan: PlanId): Promise<CheckoutSessionResult>;
  /** Open a self-service billing management session (invoices, cancel, update card) for this org. */
  createPortalSession(organizationId: string): Promise<PortalSessionResult>;
  /**
   * Verify and apply a provider webhook event. Must reject (throw)
   * anything that doesn't verify, and must be idempotent against the
   * same event id being delivered more than once.
   */
  handleWebhookEvent(rawBody: string | Buffer, signature: string | null): Promise<void>;
}
