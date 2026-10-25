/**
 * Real proof of Stripe webhook signature verification + idempotency
 * (Phase 6).
 *
 * IMPORTANT — what this test does and does NOT exercise:
 *  - This sandbox has no live or test-mode Stripe account connected, so
 *    these tests do NOT make any network call to the real Stripe API.
 *  - What IS real: the `stripe` npm package's actual signature
 *    verification code path (`stripe.webhooks.constructEvent`), run
 *    against payloads signed with the real HMAC-SHA256 scheme Stripe
 *    documents for webhook signatures (`t=<timestamp>,v1=<hex hmac of
 *    "<timestamp>.<payload>">`), using the SAME `stripe` package's own
 *    OFFLINE test helper for constructing that header
 *    (`stripe.webhooks.generateTestHeaderString`) — this is a function
 *    Stripe ships specifically so webhook handlers can be tested without
 *    a live account, not something hand-rolled for this test to look
 *    more real than it is.
 *  - The actual Route Handler (`POST` in
 *    src/app/api/stripe/webhook/route.ts) is called directly with a
 *    hand-built `NextRequest` carrying the signed body + header, exactly
 *    the function that would run under a real HTTP POST — this proves
 *    the wiring, not just the `stripe` library in isolation.
 *  - Idempotency is proved against the real `org_plans` and
 *    `stripe_events` tables in the real Postgres instance: the exact
 *    same signed payload is POSTed twice, and the test asserts the
 *    second delivery is a no-op (one row in `stripe_events`, the plan
 *    update applied exactly once).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import Stripe from "stripe";
import { db } from "@/db";
import { orgPlans, stripeEvents } from "@/db/app-schema";
import { createUserAndOrg } from "@/lib/test-support/auth-fixtures";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";
import { countProcessedStripeEvents } from "./plan-sync";

const FAKE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;
if (!FAKE_WEBHOOK_SECRET) throw new Error("STRIPE_WEBHOOK_SECRET must be set for this test (see .env)");

function signedRequest(payload: string, opts: { signature?: string } = {}): NextRequest {
  const header =
    opts.signature ??
    Stripe.webhooks.generateTestHeaderString({ payload, secret: FAKE_WEBHOOK_SECRET });
  return new NextRequest("http://localhost:3000/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

function subscriptionEvent(opts: {
  id: string;
  type: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted";
  organizationId: string;
  priceId: string;
  status?: string;
  currentPeriodEnd?: number;
}): string {
  return JSON.stringify({
    id: opts.id,
    object: "event",
    type: opts.type,
    data: {
      object: {
        id: `sub_${opts.id}`,
        object: "subscription",
        customer: `cus_${opts.id}`,
        status: opts.status ?? "active",
        current_period_end: opts.currentPeriodEnd ?? Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        metadata: { organizationId: opts.organizationId },
        items: { data: [{ price: { id: opts.priceId } }] },
      },
    },
  });
}

describe("Stripe webhook: real HMAC signature verification (offline test keys)", () => {
  it("accepts a correctly-signed payload (valid signature, same scheme Stripe uses)", async () => {
    const org = await createUserAndOrg("StripeSig-Owner");
    const payload = subscriptionEvent({
      id: `evt_sig_ok_${Date.now()}`,
      type: "customer.subscription.updated",
      organizationId: org.organizationId,
      priceId: process.env.STRIPE_PRICE_STARTER!,
    });
    const res = await stripeWebhook(signedRequest(payload));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
  });

  it("rejects a payload with NO signature header at all", async () => {
    const payload = subscriptionEvent({
      id: `evt_no_sig_${Date.now()}`,
      type: "customer.subscription.updated",
      organizationId: "whatever",
      priceId: process.env.STRIPE_PRICE_STARTER!,
    });
    const req = new NextRequest("http://localhost:3000/api/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const res = await stripeWebhook(req);
    expect(res.status).toBe(400);
  });

  it("rejects a payload signed with the WRONG secret", async () => {
    const payload = subscriptionEvent({
      id: `evt_wrong_secret_${Date.now()}`,
      type: "customer.subscription.updated",
      organizationId: "whatever",
      priceId: process.env.STRIPE_PRICE_STARTER!,
    });
    const badHeader = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_totally_different_secret" });
    const res = await stripeWebhook(signedRequest(payload, { signature: badHeader }));
    expect(res.status).toBe(400);
  });

  it("rejects a TAMPERED payload (signature was computed over different bytes)", async () => {
    const originalPayload = subscriptionEvent({
      id: `evt_tamper_${Date.now()}`,
      type: "customer.subscription.updated",
      organizationId: "org-should-not-matter",
      priceId: process.env.STRIPE_PRICE_STARTER!,
    });
    const validHeaderForOriginal = Stripe.webhooks.generateTestHeaderString({
      payload: originalPayload,
      secret: FAKE_WEBHOOK_SECRET,
    });
    // Attacker swaps the body after the signature was computed (e.g.
    // trying to redirect the plan change to a different org) but reuses
    // the old header.
    const tamperedPayload = originalPayload.replace("org-should-not-matter", "attacker-org");
    const res = await stripeWebhook(signedRequest(tamperedPayload, { signature: validHeaderForOriginal }));
    expect(res.status).toBe(400);
  });

  it("rejects a header with a timestamp far outside Stripe's replay tolerance", async () => {
    const payload = subscriptionEvent({
      id: `evt_old_${Date.now()}`,
      type: "customer.subscription.updated",
      organizationId: "whatever",
      priceId: process.env.STRIPE_PRICE_STARTER!,
    });
    const ancientTimestamp = Math.floor(Date.now() / 1000) - 10 * 24 * 3600; // 10 days old
    const header = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: FAKE_WEBHOOK_SECRET,
      timestamp: ancientTimestamp,
    });
    const res = await stripeWebhook(signedRequest(payload, { signature: header }));
    expect(res.status).toBe(400);
  });
});

describe("Stripe webhook: idempotency (same event id delivered twice)", () => {
  it("applies a subscription-updated event's plan change exactly once, even when the identical signed payload is POSTed twice", async () => {
    const org = await createUserAndOrg("StripeIdem-Owner");
    const eventId = `evt_idem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = subscriptionEvent({
      id: eventId,
      type: "customer.subscription.updated",
      organizationId: org.organizationId,
      priceId: process.env.STRIPE_PRICE_PROFESSIONAL!,
      status: "active",
    });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: FAKE_WEBHOOK_SECRET });

    const res1 = await stripeWebhook(signedRequest(payload, { signature: header }));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.applied).toBe(true);

    // Exact same signed request, delivered again (Stripe explicitly
    // documents retries can redeliver the same event id).
    const res2 = await stripeWebhook(signedRequest(payload, { signature: header }));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.applied).toBe(false); // the handler recognizes the duplicate and no-ops

    // Only ONE row recorded for this event id — not two.
    const processedCount = await countProcessedStripeEvents(eventId);
    expect(processedCount).toBe(1);

    // The org's plan was set to "professional" by the first delivery and
    // was NOT double-applied/reset by the second.
    const [planRow] = await db.select().from(orgPlans).where(eq(orgPlans.organizationId, org.organizationId));
    expect(planRow.plan).toBe("professional");
    expect(planRow.status).toBe("active");
  });

  it("a subsequent DIFFERENT event id for the same org is still applied (idempotency is per-event-id, not a blanket lock)", async () => {
    const org = await createUserAndOrg("StripeIdem2-Owner");
    const firstEventId = `evt_idem2_a_${Date.now()}`;
    const secondEventId = `evt_idem2_b_${Date.now()}`;

    const firstPayload = subscriptionEvent({
      id: firstEventId,
      type: "customer.subscription.updated",
      organizationId: org.organizationId,
      priceId: process.env.STRIPE_PRICE_STARTER!,
    });
    await stripeWebhook(signedRequest(firstPayload));

    const secondPayload = subscriptionEvent({
      id: secondEventId,
      type: "customer.subscription.updated",
      organizationId: org.organizationId,
      priceId: process.env.STRIPE_PRICE_AGENCY!,
    });
    const res2 = await stripeWebhook(signedRequest(secondPayload));
    expect(res2.status).toBe(200);
    expect((await res2.json()).applied).toBe(true);

    const [planRow] = await db.select().from(orgPlans).where(eq(orgPlans.organizationId, org.organizationId));
    expect(planRow.plan).toBe("agency"); // the second, different event's change DID take effect

    expect(await countProcessedStripeEvents(firstEventId)).toBe(1);
    expect(await countProcessedStripeEvents(secondEventId)).toBe(1);
  });

  it("a subscription-deleted event resets the org to the free plan", async () => {
    const org = await createUserAndOrg("StripeCancel-Owner");
    await db.insert(orgPlans).values({ organizationId: org.organizationId, plan: "professional", status: "active" });

    const payload = JSON.stringify({
      id: `evt_cancel_${Date.now()}`,
      object: "event",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_cancel_test",
          object: "subscription",
          customer: "cus_cancel_test",
          status: "canceled",
          metadata: { organizationId: org.organizationId },
          items: { data: [{ price: { id: process.env.STRIPE_PRICE_PROFESSIONAL } }] },
        },
      },
    });
    const res = await stripeWebhook(signedRequest(payload));
    expect(res.status).toBe(200);

    const [planRow] = await db.select().from(orgPlans).where(eq(orgPlans.organizationId, org.organizationId));
    expect(planRow.plan).toBe("free");
    expect(planRow.status).toBe("canceled");
  });
});

describe("stripe-client: refuses a live-mode secret key", () => {
  it("throws LiveStripeKeyRejectedError for an sk_live_ key, never constructing a client", async () => {
    const { getStripeClient, _resetStripeClientForTests, LiveStripeKeyRejectedError } = await import("./stripe-client");
    const original = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_live_this_should_never_be_accepted";
    _resetStripeClientForTests();
    try {
      expect(() => getStripeClient()).toThrow(LiveStripeKeyRejectedError);
    } finally {
      process.env.STRIPE_SECRET_KEY = original;
      _resetStripeClientForTests();
    }
  });
});

beforeAll(() => {
  // Sanity-check the fixtures table exists before the suite runs (fails
  // fast with a clear message instead of a confusing per-test error if
  // migrations weren't applied).
  return db.select().from(stripeEvents).limit(1);
});
