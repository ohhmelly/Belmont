/**
 * Real proof of the two things Stripe webhook handling MUST get right,
 * done entirely OFFLINE — no real Stripe account, no network call to
 * Stripe's servers, and no real test-mode API key required:
 *
 *  1. Signature verification: a real signed test header, built with
 *     Stripe's OWN SDK helper (`stripe.webhooks.generateTestHeaderString`
 *     — the exact mechanism the spec calls out as working offline), is
 *     ACCEPTED, while a tampered/invalid signature is REJECTED. This is
 *     `stripe.webhooks.constructEvent` doing the verification — nothing
 *     here reimplements HMAC checking.
 *  2. Idempotency: delivering the SAME event id twice only applies the
 *     resulting subscription state change once — proven by mutating the
 *     DB row out-of-band between the two deliveries and confirming the
 *     second (duplicate) delivery does not revert that mutation.
 *
 * What this file does NOT verify (and cannot, without real Stripe test
 * keys — see the completion report): `createCheckoutSession` and
 * `createPortalSession`'s real network calls to Stripe's API
 * (`stripe.customers.create`, `stripe.checkout.sessions.create`,
 * `stripe.billingPortal.sessions.create`), and the real end-to-end
 * "Stripe sends us a webhook after a real checkout" flow. Those paths
 * are implemented and type-checked but UNEXERCISED in this session.
 */
import { describe, it, expect, afterEach } from "vitest";
import Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/auth-schema";
import { subscriptions, processedWebhookEvents } from "@/db/app-schema";
import { StripeProvider } from "./stripe-provider";

const FAKE_WEBHOOK_SECRET = "whsec_test_fake_secret_for_offline_signature_tests";

// A second, throwaway Stripe client used ONLY to build a correctly-signed
// test header via Stripe's own offline helper — it never makes a network
// call (generateTestHeaderString is pure local HMAC, see Webhooks.js).
const signingHelper = new Stripe("sk_test_dummy_key_never_used_for_a_real_call", {
  apiVersion: "2026-09-30.endive",
});

function signedHeader(payload: string, secret = FAKE_WEBHOOK_SECRET): string {
  return signingHelper.webhooks.generateTestHeaderString({ payload, secret });
}

function makeProvider(webhookSecret = FAKE_WEBHOOK_SECRET): StripeProvider {
  return new StripeProvider({
    secretKey: "sk_test_dummy_key_never_used_for_a_real_call",
    webhookSecret,
    priceIds: {},
    appBaseUrl: "http://localhost:3000",
  });
}

const createdOrgIds: string[] = [];
async function makeOrgWithSubscription(plan: string): Promise<string> {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const orgId = `test-org-stripe-${uniq}`;
  await db.insert(organizations).values({ id: orgId, name: "Stripe Test Org", slug: orgId, createdAt: new Date() });
  await db.insert(subscriptions).values({ organizationId: orgId, plan, status: "active" });
  createdOrgIds.push(orgId);
  return orgId;
}

afterEach(async () => {
  for (const id of createdOrgIds.splice(0)) {
    await db.delete(organizations).where(eq(organizations.id, id)).catch(() => {});
  }
});

describe("StripeProvider constructor — never permits a live-looking key outside tests", () => {
  it("refuses a non sk_test_ key when NODE_ENV is not 'test'", () => {
    const env = process.env as { NODE_ENV: string };
    const original = env.NODE_ENV;
    try {
      // NODE_ENV is read-only in its official type; this test deliberately
      // overrides it (via a widened local alias) for one synchronous
      // assertion, then restores it immediately.
      env.NODE_ENV = "production";
      expect(() => makeProviderWithKey("sk_live_this_must_never_be_accepted")).toThrow(/TEST-mode key/);
    } finally {
      env.NODE_ENV = original;
    }
  });

  function makeProviderWithKey(secretKey: string) {
    return new StripeProvider({ secretKey, webhookSecret: FAKE_WEBHOOK_SECRET, priceIds: {}, appBaseUrl: "http://localhost:3000" });
  }
});

describe("StripeProvider.handleWebhookEvent — signature verification (real Stripe SDK, fully offline)", () => {
  it("rejects a request with an invalid/tampered signature", async () => {
    const provider = makeProvider();
    const payload = JSON.stringify({ id: "evt_bad_sig_1", type: "checkout.session.completed", data: { object: {} } });
    const validHeader = signedHeader(payload);
    // Tamper with the payload AFTER signing — the signature no longer matches.
    const tamperedPayload = payload.replace("evt_bad_sig_1", "evt_bad_sig_1_TAMPERED");

    await expect(provider.handleWebhookEvent(tamperedPayload, validHeader)).rejects.toThrow();
  });

  it("rejects a request signed with the WRONG webhook secret", async () => {
    const provider = makeProvider(); // configured with FAKE_WEBHOOK_SECRET
    const payload = JSON.stringify({ id: "evt_wrong_secret_1", type: "checkout.session.completed", data: { object: {} } });
    const headerSignedWithDifferentSecret = signedHeader(payload, "whsec_a_totally_different_secret");

    await expect(provider.handleWebhookEvent(payload, headerSignedWithDifferentSecret)).rejects.toThrow();
  });

  it("rejects a request with no signature header at all", async () => {
    const provider = makeProvider();
    const payload = JSON.stringify({ id: "evt_no_sig_1", type: "checkout.session.completed", data: { object: {} } });
    await expect(provider.handleWebhookEvent(payload, null)).rejects.toThrow(/Missing Stripe-Signature/);
  });

  it("accepts a request with a correctly signed, untampered payload and applies the state change", async () => {
    const orgId = await makeOrgWithSubscription("free");
    const provider = makeProvider();
    const payload = JSON.stringify({
      id: `evt_valid_${Date.now()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { organizationId: orgId, plan: "professional" },
          subscription: "sub_test_abc123",
        },
      },
    });
    const header = signedHeader(payload);

    await expect(provider.handleWebhookEvent(payload, header)).resolves.toBeUndefined();

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    expect(row.plan).toBe("professional");
    expect(row.stripeSubscriptionId).toBe("sub_test_abc123");
    expect(row.status).toBe("active");
  });
});

describe("StripeProvider.handleWebhookEvent — idempotency (same event id delivered twice)", () => {
  it("applies a checkout.session.completed event only once, not twice", async () => {
    const orgId = await makeOrgWithSubscription("free");
    const provider = makeProvider();
    const eventId = `evt_idempotency_${Date.now()}`;
    const payload = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          metadata: { organizationId: orgId, plan: "professional" },
          subscription: "sub_test_first_delivery",
        },
      },
    });
    const header = signedHeader(payload);

    // First delivery: applies the plan change for real.
    await provider.handleWebhookEvent(payload, header);
    const [afterFirst] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    expect(afterFirst.plan).toBe("professional");

    // Out-of-band mutation BETWEEN deliveries, simulating something else
    // having changed the row (e.g. a manual support action) — if the
    // second delivery were to re-apply the event, it would stomp this
    // back to "professional". It must not.
    await db.update(subscriptions).set({ plan: "starter" }).where(eq(subscriptions.organizationId, orgId));

    // Second delivery of the EXACT SAME event id — must be a no-op.
    await provider.handleWebhookEvent(payload, header);
    const [afterSecond] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    expect(afterSecond.plan).toBe("starter"); // unchanged by the duplicate delivery

    // The ledger has exactly one row for this event id, not two.
    const ledgerRows = await db.select().from(processedWebhookEvents).where(eq(processedWebhookEvents.id, eventId));
    expect(ledgerRows).toHaveLength(1);
  });
});
