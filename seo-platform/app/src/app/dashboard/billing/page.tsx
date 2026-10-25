import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getMembership } from "@/lib/auth/require-org-access";
import { getOrgPlan, PLAN_LIMITS, PLAN_IDS } from "@/lib/plans/limits";
import { createCheckoutSessionAction } from "../actions";

/**
 * Minimal billing/plan view (Phase 6). Shows the org's current plan and
 * example limits, and — owner/admin only — an "Upgrade" button per paid
 * tier that starts a TEST-MODE Stripe Checkout session (see
 * src/lib/billing/stripe-client.ts). The actual plan/status shown here
 * is written by the Stripe webhook (src/app/api/stripe/webhook/route.ts)
 * once a checkout completes, not by anything on this page.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { checkout } = await searchParams;
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/login");

  const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
  const activeOrg = organizations[0] ?? null;
  if (!activeOrg) {
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
        <p>No organization yet.</p>
      </main>
    );
  }

  const membership = await getMembership(session.user.id, activeOrg.id);
  const canManageBilling = membership?.role === "owner" || membership?.role === "admin";
  const planState = await getOrgPlan(activeOrg.id);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12 space-y-6">
      <header>
        <a href="/dashboard" className="text-sm text-foreground/60 hover:underline">
          &larr; Dashboard
        </a>
        <h1 className="mt-2 text-2xl font-semibold">Billing</h1>
      </header>

      <div className="rounded-md border border-amber-300/50 bg-amber-50/50 p-3 text-xs text-foreground/70 dark:bg-amber-950/20">
        TEST MODE ONLY. This project never accepts real payments &mdash; Stripe is configured with
        test-mode keys/prices only (see .env.example). Going live is a separate, explicit decision for
        the project owner to make later.
      </div>

      {checkout === "success" && (
        <p className="rounded-md bg-green-50 p-3 text-sm text-green-700">
          Checkout completed. Your plan updates once Stripe&apos;s webhook confirms the subscription
          (this can take a few seconds).
        </p>
      )}
      {checkout === "cancelled" && (
        <p className="rounded-md bg-gray-50 p-3 text-sm text-gray-700">Checkout was cancelled.</p>
      )}

      <section className="rounded-md border border-foreground/10 p-4">
        <h2 className="text-sm font-medium">
          Current plan: {planState.limits.label} <span className="text-foreground/50">({planState.status})</span>
        </h2>
        <ul className="mt-2 space-y-1 text-sm text-foreground/70">
          <li>Websites: up to {planState.limits.maxWebsites}</li>
          <li>Manual crawls: up to {planState.limits.maxManualCrawlsPerMonth} per month</li>
          <li>Scheduled audits: {planState.limits.schedulingAllowed ? "allowed" : "not included"}</li>
          <li>AI recommendations: {planState.limits.aiRecommendationsAllowed ? "allowed" : "not included"}</li>
          <li>Branded reports: {planState.limits.brandedReports ? "allowed" : "not included"}</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Plans</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {PLAN_IDS.map((planId) => {
            const limits = PLAN_LIMITS[planId];
            const isCurrent = planId === planState.plan;
            return (
              <div
                key={planId}
                className={
                  "rounded-md border p-3 text-sm " +
                  (isCurrent ? "border-foreground/40 bg-foreground/5" : "border-foreground/10")
                }
              >
                <p className="font-medium">
                  {limits.label} {isCurrent && <span className="text-xs text-foreground/50">(current)</span>}
                </p>
                <p className="text-xs text-foreground/60">
                  {limits.maxWebsites} website(s) &middot; {limits.maxManualCrawlsPerMonth} crawls/mo
                </p>
                {canManageBilling && planId !== "free" && !isCurrent && (
                  <form action={createCheckoutSessionAction} className="mt-2">
                    <input type="hidden" name="plan" value={planId} />
                    <button
                      type="submit"
                      className="rounded-md border border-foreground/20 px-3 py-1 text-xs hover:bg-foreground/5"
                    >
                      Upgrade (test mode)
                    </button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
        {!canManageBilling && (
          <p className="text-xs text-foreground/50">
            Only an organization owner or admin can change the plan.
          </p>
        )}
      </section>
    </main>
  );
}
