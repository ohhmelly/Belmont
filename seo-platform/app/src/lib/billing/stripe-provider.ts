/**
 * Real Stripe integration (Phase 6) — TEST MODE ONLY, always. This
 * provider is only ever constructed when `STRIPE_SECRET_KEY` is set (see
 * `getBillingProvider()` in index.ts); nothing in this file hardcodes or
 * defaults to a live-looking key. The project owner does not have real
 * Stripe test keys yet, so this class is implemented and unit-tested
 * (signature verification, idempotency) but its actual network calls
 * (`createCheckoutSession`, `createPortalSession`, and the
 * `checkout.session.completed`/`customer.subscription.*` handling paths
 * inside `handleWebhookEvent` once a signature verifies) have NOT been
 * exercised against a real Stripe test account in this session — see the
 * completion report for exactly what was/wasn't verified.
 *
 * Webhook signature verification uses Stripe's own SDK
 * (`stripe.webhooks.constructEvent`) — nothing here reimplements HMAC
 * verification. An event that fails verification is rejected before any
 * database write happens.
 *
 * Idempotency: before applying ANY state change for a verified event,
 * `tryClaimWebhookEvent` inserts the event's id into
 * `processed_webhook_events` (primary-key-constrained). If that insert
 * is a no-op (the id was already there), the event is a duplicate
 * delivery and is skipped — this is what stops the same webhook being
 * applied twice.
 */
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { subscriptions } from "@/db/app-schema";
import { getOrCreateSubscription } from "./quota";
import { tryClaimWebhookEvent } from "./webhook-events";
import { type PlanId, isPlanId } from "./plans";
import type { BillingProvider, CheckoutSessionResult, PortalSessionResult } from "./provider";

const STRIPE_API_VERSION = "2026-09-30.endive" as const;

export interface StripeProviderConfig {
  secretKey: string;
  webhookSecret: string;
  /** Stripe Price ids for the three paid plans. Free has no price (no checkout). */
  priceIds: Partial<Record<PlanId, string>>;
  /** Base URL for success/cancel/return redirects, e.g. https://app.example.com */
  appBaseUrl: string;
}

export class StripeProvider implements BillingProvider {
  readonly name = "stripe" as const;
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;
  private readonly priceIds: Partial<Record<PlanId, string>>;
  private readonly appBaseUrl: string;

  constructor(config: StripeProviderConfig) {
    if (!config.secretKey.startsWith("sk_test_") && process.env.NODE_ENV !== "test") {
      // Belt-and-suspenders: this project never enables live payment
      // processing. A key that isn't in Stripe's test-mode format is
      // refused rather than silently used.
      throw new Error(
        "STRIPE_SECRET_KEY must be a Stripe TEST-mode key (sk_test_...). Live keys are never permitted in this project."
      );
    }
    this.stripe = new Stripe(config.secretKey, { apiVersion: STRIPE_API_VERSION });
    this.webhookSecret = config.webhookSecret;
    this.priceIds = config.priceIds;
    this.appBaseUrl = config.appBaseUrl.replace(/\/+$/, "");
  }

  private async getOrCreateStripeCustomerId(organizationId: string): Promise<string> {
    const sub = await getOrCreateSubscription(organizationId);
    if (sub.stripeCustomerId) return sub.stripeCustomerId;

    const customer = await this.stripe.customers.create({
      metadata: { organizationId },
    });
    await db
      .update(subscriptions)
      .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
      .where(eq(subscriptions.organizationId, organizationId));
    return customer.id;
  }

  async createCheckoutSession(organizationId: string, plan: PlanId): Promise<CheckoutSessionResult> {
    const priceId = this.priceIds[plan];
    if (!priceId) {
      throw new Error(`No Stripe price configured for plan "${plan}" (set STRIPE_PRICE_${plan.toUpperCase()}).`);
    }
    const customerId = await this.getOrCreateStripeCustomerId(organizationId);

    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${this.appBaseUrl}/dashboard/billing?checkout=success`,
      cancel_url: `${this.appBaseUrl}/dashboard/billing?checkout=cancelled`,
      metadata: { organizationId, plan },
      subscription_data: { metadata: { organizationId, plan } },
    });

    if (!session.url) throw new Error("Stripe did not return a Checkout session URL");
    return { url: session.url };
  }

  async createPortalSession(organizationId: string): Promise<PortalSessionResult> {
    const customerId = await this.getOrCreateStripeCustomerId(organizationId);
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${this.appBaseUrl}/dashboard/billing`,
    });
    return { url: session.url };
  }

  async handleWebhookEvent(rawBody: string | Buffer, signature: string | null): Promise<void> {
    if (!signature) {
      throw new Error("Missing Stripe-Signature header");
    }

    // Throws if the signature doesn't verify (wrong secret, tampered
    // body, expired timestamp) — this is Stripe's own SDK verification,
    // not a custom reimplementation.
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);

    const isFirstDelivery = await tryClaimWebhookEvent(event.id, event.type);
    if (!isFirstDelivery) {
      // Already processed this exact event id — duplicate delivery, skip.
      return;
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const organizationId = session.metadata?.organizationId;
        const planRaw = session.metadata?.plan;
        if (!organizationId || !planRaw || !isPlanId(planRaw)) break;
        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
        await getOrCreateSubscription(organizationId);
        await db
          .update(subscriptions)
          .set({
            plan: planRaw,
            status: "active",
            stripeSubscriptionId: subscriptionId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.organizationId, organizationId));
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const organizationId = sub.metadata?.organizationId;
        const planRaw = sub.metadata?.plan;
        if (!organizationId) break;
        const periodItem = sub.items.data[0];
        await db
          .update(subscriptions)
          .set({
            ...(planRaw && isPlanId(planRaw) ? { plan: planRaw } : {}),
            status: mapStripeStatus(sub.status),
            currentPeriodStart: periodItem ? new Date(periodItem.current_period_start * 1000) : null,
            currentPeriodEnd: periodItem ? new Date(periodItem.current_period_end * 1000) : null,
            updatedAt: new Date(),
          })
          .where(eq(subscriptions.organizationId, organizationId));
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const organizationId = sub.metadata?.organizationId;
        if (!organizationId) break;
        await db
          .update(subscriptions)
          .set({ plan: "free", status: "canceled", updatedAt: new Date() })
          .where(eq(subscriptions.organizationId, organizationId));
        break;
      }

      default:
        // Other event types are intentionally ignored — they're still
        // recorded in processed_webhook_events (above) so a retry of an
        // event type we DO act on isn't confused with a first delivery.
        break;
    }
  }
}

function mapStripeStatus(status: Stripe.Subscription.Status): string {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
      return "past_due";
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
      return "canceled";
    default:
      return "incomplete";
  }
}

export function loadStripeProviderConfigFromEnv(): StripeProviderConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  return {
    secretKey,
    webhookSecret,
    appBaseUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
    priceIds: {
      starter: process.env.STRIPE_PRICE_STARTER,
      professional: process.env.STRIPE_PRICE_PROFESSIONAL,
      agency: process.env.STRIPE_PRICE_AGENCY,
    },
  };
}
