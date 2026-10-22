/**
 * Billing provider selection (Phase 6). `STRIPE_SECRET_KEY` unset
 * (the default — the project owner has no real Stripe keys yet) ->
 * `MockBillingProvider`. Set -> real `StripeProvider`, test-mode only.
 */
import { MockBillingProvider } from "./mock-provider";
import { StripeProvider, loadStripeProviderConfigFromEnv } from "./stripe-provider";
import type { BillingProvider } from "./provider";

let cached: BillingProvider | null = null;

export function getBillingProvider(): BillingProvider {
  if (cached) return cached;
  const stripeConfig = loadStripeProviderConfigFromEnv();
  cached = stripeConfig ? new StripeProvider(stripeConfig) : new MockBillingProvider();
  return cached;
}

/** Test-only: forces the next getBillingProvider() call to rebuild (env vars may have changed). */
export function resetBillingProviderCache(): void {
  cached = null;
}

export * from "./provider";
export * from "./plans";
export * from "./quota";
