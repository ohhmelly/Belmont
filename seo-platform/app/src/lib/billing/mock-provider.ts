/**
 * Mock billing provider (Phase 6) — the DEFAULT provider, used whenever
 * `STRIPE_SECRET_KEY` is unset (the project owner does not have Stripe
 * test keys yet; this is their explicit choice, not a fallback we chose
 * unilaterally). No network calls, no real payment processing of any
 * kind. "Checkout" and "portal" both resolve by directly editing the
 * org's `subscriptions` row, so the full upgrade/downgrade flow can be
 * exercised end to end — in tests and in the dashboard UI — without a
 * Stripe account.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { subscriptions } from "@/db/app-schema";
import { getOrCreateSubscription } from "./quota";
import type { BillingProvider, CheckoutSessionResult, PortalSessionResult } from "./provider";
import type { PlanId } from "./plans";

export class MockBillingProvider implements BillingProvider {
  readonly name = "mock" as const;

  /**
   * Immediately "upgrades"/"downgrades" the org to `plan` — no Stripe
   * customer/subscription ids are ever set by this path, matching the
   * table comment in app-schema.ts (null until a REAL Stripe checkout
   * completes).
   */
  async createCheckoutSession(organizationId: string, plan: PlanId): Promise<CheckoutSessionResult> {
    await getOrCreateSubscription(organizationId);
    await db
      .update(subscriptions)
      .set({ plan, status: "active", updatedAt: new Date() })
      .where(eq(subscriptions.organizationId, organizationId));
    return { url: `/dashboard/billing?mock_checkout=success&plan=${plan}` };
  }

  /** No real customer portal exists in mock mode — send the user back to the billing page. */
  async createPortalSession(organizationId: string): Promise<PortalSessionResult> {
    await getOrCreateSubscription(organizationId);
    return { url: "/dashboard/billing?mock_portal=true" };
  }

  /**
   * There is no real webhook sender in mock mode (no Stripe account to
   * send one), so this is a documented no-op rather than something any
   * code path should ever call.
   */
  async handleWebhookEvent(_rawBody: string | Buffer, _signature: string | null): Promise<void> {
    throw new Error("MockBillingProvider does not receive webhooks — there is no real Stripe account configured.");
  }
}
