/**
 * Stripe webhook receiver (Phase 6). Deliberately does NOT use
 * `requireActiveOrgId`/session auth — Stripe calls this endpoint directly
 * server-to-server with no user session, authenticated instead by the
 * webhook signature itself (verified inside `handleWebhookEvent` via
 * Stripe's own SDK). The raw request body is read as text/bytes (never
 * `req.json()`) because signature verification needs the exact bytes
 * Stripe signed, not a re-serialized copy.
 *
 * When the active billing provider is the mock (no `STRIPE_SECRET_KEY`
 * configured), there is no real Stripe account to send a webhook in the
 * first place, so a request here will hit `MockBillingProvider`'s
 * documented no-op/throw — see mock-provider.ts.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getBillingProvider } from "@/lib/billing";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");

  try {
    await getBillingProvider().handleWebhookEvent(rawBody, signature);
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook processing failed";
    // Any verification/processing failure is a 400, never a 200 — Stripe
    // will retry a 400, which is correct for a signature we can't verify.
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
