/**
 * Real proof that the webhook ROUTE itself (not just the provider class)
 * is wired correctly: reads the raw body, passes it + the
 * Stripe-Signature header to the active billing provider, and turns a
 * rejection into a 400 rather than ever responding 200 to something
 * that didn't verify.
 *
 * No STRIPE_SECRET_KEY is set in this environment (see .env / the
 * completion report), so `getBillingProvider()` resolves to
 * `MockBillingProvider` here — this test is proving the ROUTE's
 * plumbing, not StripeProvider's signature verification (that's
 * src/lib/billing/stripe-provider.test.ts, fully offline against the
 * real Stripe SDK).
 */
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

describe("POST /api/webhooks/stripe", () => {
  it("returns 400 (never 200) when the active provider rejects the event", async () => {
    const req = new NextRequest("http://localhost:3000/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "fake-signature", "content-type": "application/json" },
      body: JSON.stringify({ id: "evt_test", type: "checkout.session.completed" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it("returns 400 when there is no signature header at all", async () => {
    const req = new NextRequest("http://localhost:3000/api/webhooks/stripe", {
      method: "POST",
      body: JSON.stringify({ id: "evt_test_2", type: "checkout.session.completed" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
