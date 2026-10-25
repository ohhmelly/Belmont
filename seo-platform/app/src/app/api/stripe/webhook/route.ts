/**
 * Stripe webhook endpoint (Phase 6) — TEST MODE ONLY, see
 * src/lib/billing/stripe-client.ts for why and the live-key guard.
 *
 * Real signature verification: this reads the RAW request body (never
 * `req.json()`, which would re-serialize it and break the signature)
 * and the `stripe-signature` header, then calls the real
 * `stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)`.
 * An invalid/missing/tampered signature is rejected with 400 before any
 * application code sees the payload — see stripe-webhook.test.ts for a
 * real HMAC-signed-payload proof (offline test keys, not a live Stripe
 * account; see that file's header for exactly what was and wasn't
 * exercised against the real Stripe API).
 */
import { NextResponse, type NextRequest } from "next/server";
import { getStripeClient, getStripeWebhookSecret, LiveStripeKeyRejectedError } from "@/lib/billing/stripe-client";
import { applyStripeEvent } from "@/lib/billing/plan-sync";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  const rawBody = await req.text();

  let event;
  try {
    const stripe = getStripeClient();
    const webhookSecret = getStripeWebhookSecret();
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    if (err instanceof LiveStripeKeyRejectedError) {
      // Fail closed, loudly — this must never silently accept a live-mode webhook.
      console.error("[stripe webhook]", err.message);
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    console.error("[stripe webhook] signature verification failed:", (err as Error).message);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    const result = await applyStripeEvent(event);
    return NextResponse.json({ received: true, applied: result.applied });
  } catch (err) {
    console.error("[stripe webhook] failed to apply event:", event.id, event.type, err);
    return NextResponse.json({ error: "Failed to process event" }, { status: 500 });
  }
}
