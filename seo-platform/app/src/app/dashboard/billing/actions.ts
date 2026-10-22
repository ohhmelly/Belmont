"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireActiveOrgId } from "@/lib/tenant";
import { getBillingProvider } from "@/lib/billing";
import { isPlanId } from "@/lib/billing/plans";

/**
 * Start a plan change. With a real Stripe account configured, this
 * redirects to a real Stripe Checkout URL and the plan only actually
 * changes once the `checkout.session.completed` webhook arrives (see
 * src/app/api/webhooks/stripe/route.ts). With the default mock provider
 * (no Stripe configured), the plan change is applied immediately and
 * this just redirects back to the billing page.
 */
export async function changePlan(formData: FormData): Promise<void> {
  const organizationId = await requireActiveOrgId();
  const plan = String(formData.get("plan") ?? "");
  if (!isPlanId(plan) || plan === "free") {
    throw new Error("Not a valid paid plan to switch to.");
  }
  const { url } = await getBillingProvider().createCheckoutSession(organizationId, plan);
  revalidatePath("/dashboard/billing");
  redirect(url);
}

/** Opens the billing provider's self-service management session (real Stripe customer portal, or the mock's stand-in). */
export async function openBillingPortal(): Promise<void> {
  const organizationId = await requireActiveOrgId();
  const { url } = await getBillingProvider().createPortalSession(organizationId);
  redirect(url);
}
