/**
 * Idempotency ledger for billing provider webhook events (Phase 6). The
 * same Stripe webhook event id can legitimately be delivered more than
 * once (Stripe's own retry behavior, or a person manually resending one
 * from the dashboard) — this must never double-apply a state change
 * (e.g. re-crediting a plan change, double-firing a notification).
 *
 * `processed_webhook_events.id` has a PRIMARY KEY constraint, so the
 * insert below either succeeds (first time seeing this event — caller
 * should apply the state change) or is a no-op via `onConflictDoNothing`
 * (already processed — caller must skip).
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { processedWebhookEvents } from "@/db/app-schema";

/** Returns true if this is the FIRST time this event id has been seen (caller should process it). */
export async function tryClaimWebhookEvent(eventId: string, type: string): Promise<boolean> {
  const inserted = await db
    .insert(processedWebhookEvents)
    .values({ id: eventId, type })
    .onConflictDoNothing({ target: processedWebhookEvents.id })
    .returning();
  return inserted.length > 0;
}

export async function hasProcessedWebhookEvent(eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: processedWebhookEvents.id })
    .from(processedWebhookEvents)
    .where(eq(processedWebhookEvents.id, eventId));
  return Boolean(row);
}
