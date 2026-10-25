"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireActiveOrg } from "@/lib/auth/require-org-access";
import { getBillingProvider } from "@/lib/billing";
import { isPlanId } from "@/lib/billing/plans";
import { logAudit } from "@/lib/audit/log";

/**
 * Start a plan change. With a real Stripe account configured, this
 * redirects to a real Stripe Checkout URL and the plan only actually
 * changes once the `checkout.session.completed` webhook arrives (see
 * src/app/api/webhooks/stripe/route.ts). With the default mock provider
 * (no Stripe configured), the plan change is applied immediately and
 * this just redirects back to the billing page.
 *
 * Phase 6: owner/admin only — changing billing/plan is a higher-
 * privilege action, same bucket as inviting members or deleting a
 * website — and the change is audit-logged either way (even though the
 * mock provider path means "plan changed" rather than "checkout
 * started", that distinction belongs to the provider, not the caller).
 */
export async function changePlan(formData: FormData, headersOverride?: Headers): Promise<void> {
  const { organizationId, session } = await requireActiveOrg(headersOverride, "admin");
  const plan = String(formData.get("plan") ?? "");
  if (!isPlanId(plan) || plan === "free") {
    throw new Error("Not a valid paid plan to switch to.");
  }
  const { url } = await getBillingProvider().createCheckoutSession(organizationId, plan);

  await logAudit({
    organizationId,
    actorUserId: session.userId,
    action: "plan_changed",
    targetType: "subscription",
    metadata: { plan },
  });

  revalidatePath("/dashboard/billing");
  redirect(url);
}

/** Opens the billing provider's self-service management session (real Stripe customer portal, or the mock's stand-in). */
export async function openBillingPortal(): Promise<void> {
  const { organizationId } = await requireActiveOrg(undefined, "admin");
  const { url } = await getBillingProvider().createPortalSession(organizationId);
  redirect(url);
}
