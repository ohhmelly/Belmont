/**
 * Stripe adapter (Phase 6) — TEST MODE ONLY.
 *
 * Why a thin hand-rolled adapter instead of the official `@better-auth/stripe`
 * plugin: that plugin is real and was evaluated (it's listed as a
 * devDependency candidate in package.json history / node_modules during
 * development of this phase), but wiring it in fully would (a) require
 * regenerating src/db/auth-schema.ts via the Better Auth CLI to add its
 * `subscription` table and `stripeCustomerId` columns onto `users` and
 * `organizations` — a generated file this project's own comments say not
 * to hand-edit, and a schema change that risks every already-passing
 * Phase 2-5 test that touches those tables — and (b) couples subscription
 * state into Better Auth's own session-aware endpoints for a feature this
 * phase only needs in one direction: "a verified Stripe webhook event
 * updates this org's plan in our own small `org_plans` table." A plain
 * `stripe` npm client plus one webhook route does that with far less
 * blast radius, while still using Stripe's real SDK and real
 * `stripe.webhooks.constructEvent` signature verification — the
 * security-critical part the spec asks for. See docs/ARCHITECTURE.md,
 * which named the official plugin as the planned approach; this is a
 * documented, judgment-call deviation from that plan, not a silent one.
 *
 * TEST MODE ONLY: `STRIPE_SECRET_KEY` must be a Stripe TEST key
 * (starts with `sk_test_`), never a live key (`sk_live_`). This module
 * refuses to construct a client with a key that looks like a live key,
 * so a real payment can never be taken by this code path even by
 * accident. Going live is an explicit, separate decision for the
 * project owner to make later (swap `.env`, remove the guard below only
 * with their explicit approval) — nothing here should be read as that
 * approval.
 */
import Stripe from "stripe";

export class LiveStripeKeyRejectedError extends Error {
  constructor() {
    super(
      "Refusing to start a Stripe client with what looks like a LIVE secret key (sk_live_...). " +
        "This Phase 6 billing integration is TEST MODE ONLY until the project owner explicitly approves going live. " +
        "Use a sk_test_... key in STRIPE_SECRET_KEY."
    );
    this.name = "LiveStripeKeyRejectedError";
  }
}

let cachedClient: Stripe | null = null;

/** The Stripe secret key, if configured. Does not throw — callers decide whether a missing key is fatal for their path. */
export function getStripeSecretKey(): string | undefined {
  return process.env.STRIPE_SECRET_KEY;
}

export function isLiveKey(key: string): boolean {
  return key.startsWith("sk_live_") || key.startsWith("rk_live_");
}

/**
 * Lazily construct (and cache) a Stripe client from `STRIPE_SECRET_KEY`.
 * Throws LiveStripeKeyRejectedError if the configured key looks live.
 * Throws a plain Error if no key is configured at all (billing features
 * are optional — callers should catch this and degrade, not crash the
 * whole app).
 */
export function getStripeClient(): Stripe {
  if (cachedClient) return cachedClient;
  const key = getStripeSecretKey();
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set. Billing features are disabled until it is configured (test-mode key only).");
  }
  if (isLiveKey(key)) {
    throw new LiveStripeKeyRejectedError();
  }
  cachedClient = new Stripe(key, { apiVersion: "2025-02-24.acacia" });
  return cachedClient;
}

export function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set; cannot verify webhook signatures.");
  }
  return secret;
}

/** Test-only: reset the cached client so tests can swap env vars between cases. */
export function _resetStripeClientForTests(): void {
  cachedClient = null;
}
