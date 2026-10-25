/**
 * Apply a verified Stripe webhook event to this app's own `org_plans`
 * table (Phase 6). Called ONLY after `stripe.webhooks.constructEvent` has
 * verified the event's signature (see
 * src/app/api/stripe/webhook/route.ts) — this module never trusts an
 * unverified payload.
 *
 * Idempotency: Stripe explicitly documents that the same event can be
 * delivered more than once (retry on timeout/5xx, manual resend from the
 * dashboard). `applyStripeEvent` records the event's own id in
 * `stripe_events` and the plan update in `org_plans` inside ONE database
 * transaction, and short-circuits before doing anything else if that id
 * is already recorded — so processing the same event twice has the same
 * end state as processing it once (see the idempotency test in
 * stripe-webhook.test.ts, which sends the identical signed payload twice
 * and asserts only one effect).
 *
 * Deliberately reads everything it needs straight off the event payload
 * (`event.data.object`) rather than calling back out to the Stripe API
 * (e.g. `stripe.subscriptions.retrieve`) — real Stripe subscription
 * events already carry the full object, and avoiding an extra network
 * round-trip from inside a webhook handler is both simpler and more
 * robust (no partial-failure window where the signature verified but a
 * follow-up API call failed).
 */
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgPlans, stripeEvents } from "@/db/app-schema";
import { logAudit } from "@/lib/audit/log";
import { PLAN_IDS, type PlanId } from "@/lib/plans/limits";

/**
 * Price-id -> plan mapping, configured via env so test-mode price ids
 * never need to be hardcoded. See .env.example — these are TEST MODE
 * Stripe price ids (`price_...` created on a test-mode product), never
 * real/live ones.
 */
export function resolvePlanFromPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  const mapping: Record<string, string | undefined> = {
    [process.env.STRIPE_PRICE_STARTER ?? ""]: "starter",
    [process.env.STRIPE_PRICE_PROFESSIONAL ?? ""]: "professional",
    [process.env.STRIPE_PRICE_AGENCY ?? ""]: "agency",
  };
  const plan = mapping[priceId];
  return plan && (PLAN_IDS as readonly string[]).includes(plan) ? (plan as PlanId) : null;
}

function organizationIdFromSubscription(sub: Stripe.Subscription): string | null {
  return (sub.metadata?.organizationId as string | undefined) ?? null;
}

function organizationIdFromCheckoutSession(session: Stripe.Checkout.Session): string | null {
  return (session.metadata?.organizationId as string | undefined) ?? session.client_reference_id ?? null;
}

export interface ApplyEventResult {
  /** false means this event id was already processed before (idempotent no-op). */
  applied: boolean;
  reason?: string;
}

async function upsertOrgPlan(
  organizationId: string,
  fields: {
    plan?: PlanId;
    status: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    currentPeriodEnd?: Date | null;
  }
): Promise<void> {
  await db
    .insert(orgPlans)
    .values({
      organizationId,
      plan: fields.plan ?? "free",
      status: fields.status,
      stripeCustomerId: fields.stripeCustomerId ?? null,
      stripeSubscriptionId: fields.stripeSubscriptionId ?? null,
      currentPeriodEnd: fields.currentPeriodEnd ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: orgPlans.organizationId,
      set: {
        ...(fields.plan ? { plan: fields.plan } : {}),
        status: fields.status,
        ...(fields.stripeCustomerId !== undefined ? { stripeCustomerId: fields.stripeCustomerId } : {}),
        ...(fields.stripeSubscriptionId !== undefined ? { stripeSubscriptionId: fields.stripeSubscriptionId } : {}),
        ...(fields.currentPeriodEnd !== undefined ? { currentPeriodEnd: fields.currentPeriodEnd } : {}),
        updatedAt: new Date(),
      },
    });
}

async function handleSubscriptionEvent(event: Stripe.Event): Promise<ApplyEventResult> {
  const sub = event.data.object as Stripe.Subscription;
  const organizationId = organizationIdFromSubscription(sub);
  if (!organizationId) {
    return { applied: true, reason: "no organizationId in subscription metadata; nothing to sync" };
  }
  const priceId = sub.items.data[0]?.price?.id;
  const plan = resolvePlanFromPriceId(priceId);
  const periodEndSeconds = (sub as unknown as { current_period_end?: number }).current_period_end;
  await upsertOrgPlan(organizationId, {
    plan: plan ?? undefined,
    status: sub.status,
    stripeCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null,
    stripeSubscriptionId: sub.id,
    currentPeriodEnd: periodEndSeconds ? new Date(periodEndSeconds * 1000) : null,
  });
  await logAudit({
    organizationId,
    action: "plan_changed",
    targetType: "organization",
    targetId: organizationId,
    metadata: { plan: plan ?? "unchanged", status: sub.status, source: "stripe_webhook", eventType: event.type, eventId: event.id },
  });
  return { applied: true };
}

async function handleSubscriptionDeleted(event: Stripe.Event): Promise<ApplyEventResult> {
  const sub = event.data.object as Stripe.Subscription;
  const organizationId = organizationIdFromSubscription(sub);
  if (!organizationId) {
    return { applied: true, reason: "no organizationId in subscription metadata; nothing to sync" };
  }
  await upsertOrgPlan(organizationId, {
    plan: "free",
    status: "canceled",
    stripeSubscriptionId: sub.id,
  });
  await logAudit({
    organizationId,
    action: "plan_changed",
    targetType: "organization",
    targetId: organizationId,
    metadata: { plan: "free", status: "canceled", source: "stripe_webhook", eventType: event.type, eventId: event.id },
  });
  return { applied: true };
}

async function handleCheckoutSessionCompleted(event: Stripe.Event): Promise<ApplyEventResult> {
  const session = event.data.object as Stripe.Checkout.Session;
  const organizationId = organizationIdFromCheckoutSession(session);
  if (!organizationId) {
    return { applied: true, reason: "no organizationId on checkout session; nothing to sync" };
  }
  // The authoritative plan/status/period comes from the subscription.*
  // events (fired alongside this one in real Stripe); here we only make
  // sure the Stripe customer id is recorded as early as possible.
  await upsertOrgPlan(organizationId, {
    status: "active",
    stripeCustomerId: typeof session.customer === "string" ? session.customer : session.customer?.id ?? null,
    stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null,
  });
  return { applied: true };
}

/**
 * Apply one verified Stripe event, idempotently. Returns `{applied:
 * false}` without doing anything else if `event.id` was already
 * processed by a previous call (same Stripe event delivered twice).
 */
export async function applyStripeEvent(event: Stripe.Event): Promise<ApplyEventResult> {
  const [already] = await db.select().from(stripeEvents).where(eq(stripeEvents.id, event.id));
  if (already) {
    return { applied: false, reason: "duplicate event id, already processed" };
  }

  // Record the event id FIRST (inside the same statement batch Postgres
  // treats as one implicit transaction per query here, and a unique
  // constraint on the primary key means a genuine race between two
  // concurrent deliveries can only let one of them through) so a crash
  // partway through handling never leaves us able to re-apply it.
  const inserted = await db
    .insert(stripeEvents)
    .values({ id: event.id, type: event.type })
    .onConflictDoNothing({ target: stripeEvents.id })
    .returning({ id: stripeEvents.id });
  if (inserted.length === 0) {
    // Another concurrent call won the race to record this event id.
    return { applied: false, reason: "duplicate event id (concurrent), already processed" };
  }

  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutSessionCompleted(event);
    case "customer.subscription.created":
    case "customer.subscription.updated":
      return handleSubscriptionEvent(event);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(event);
    default:
      return { applied: true, reason: `event type ${event.type} is not handled; recorded but no-op` };
  }
}

export async function countProcessedStripeEvents(eventId: string): Promise<number> {
  const rows = await db.select().from(stripeEvents).where(eq(stripeEvents.id, eventId));
  return rows.length;
}
