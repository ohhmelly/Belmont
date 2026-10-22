import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { getUsageSummary } from "@/lib/billing/quota";
import { PLANS, PLAN_IDS, type PlanId } from "@/lib/billing/plans";
import { getBillingProvider } from "@/lib/billing";
import { changePlan, openBillingPortal } from "./actions";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/login");

  const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
  const activeOrg = organizations[0] ?? null;
  if (!activeOrg) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        <p>No organization yet.</p>
      </main>
    );
  }

  const params = await searchParams;
  const usage = await getUsageSummary(activeOrg.id);
  const provider = getBillingProvider();

  const flash =
    params.checkout === "success"
      ? "Checkout complete — your plan will update once Stripe confirms the subscription (webhook)."
      : params.checkout === "cancelled"
        ? "Checkout cancelled — your plan is unchanged."
        : params.mock_checkout === "success"
          ? `Plan switched to ${String(params.plan ?? "").toString()} (mock billing — no real payment was processed).`
          : null;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12 space-y-8">
      <header>
        <a href="/dashboard" className="text-sm text-foreground/60 hover:underline">
          &larr; Dashboard
        </a>
        <h1 className="mt-2 text-2xl font-semibold">Plan &amp; billing</h1>
        <p className="mt-1 text-sm text-foreground/60">
          Billing provider:{" "}
          <span className="font-mono">{provider.name}</span>
          {provider.name === "mock" && (
            <span className="text-foreground/50">
              {" "}
              — no STRIPE_SECRET_KEY configured; plan changes below apply instantly with no real payment.
            </span>
          )}
        </p>
      </header>

      {flash && (
        <div className="rounded-md border border-blue-300/40 bg-blue-50/50 p-3 text-sm dark:bg-blue-950/20">
          {flash}
        </div>
      )}

      <section className="rounded-md border border-foreground/10 p-4 space-y-3">
        <h2 className="text-sm font-medium">Current plan</h2>
        <p className="text-lg font-semibold">
          {usage.plan.name}{" "}
          <span className="text-sm font-normal text-foreground/50">
            (${usage.plan.priceUsdPerMonth}/mo — illustrative pricing, not final) · status: {usage.status}
          </span>
        </p>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div className="rounded bg-foreground/5 p-3">
            <dt className="text-foreground/50">Websites</dt>
            <dd className="font-medium">
              {usage.websiteCount} / {usage.plan.limits.maxWebsites}
            </dd>
          </div>
          <div className="rounded bg-foreground/5 p-3">
            <dt className="text-foreground/50">Manual crawls this month</dt>
            <dd className="font-medium">
              {usage.manualCrawlsThisMonth} /{" "}
              {usage.plan.limits.manualCrawlsPerMonth ?? "unlimited"}
            </dd>
          </div>
          <div className="rounded bg-foreground/5 p-3">
            <dt className="text-foreground/50">Scheduled monitoring</dt>
            <dd className="font-medium">{usage.plan.limits.schedulingEnabled ? "Enabled" : "Not included"}</dd>
          </div>
          <div className="rounded bg-foreground/5 p-3">
            <dt className="text-foreground/50">AI recommendations</dt>
            <dd className="font-medium">
              {usage.plan.limits.aiRecommendationsEnabled ? "Enabled" : "Template-only"}
            </dd>
          </div>
        </dl>

        {usage.plan.id !== "free" && (
          <form action={openBillingPortal}>
            <button
              type="submit"
              className="rounded-md border border-foreground/20 px-3 py-1.5 text-sm hover:bg-foreground/5"
            >
              Manage billing
            </button>
          </form>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Change plan</h2>
        <p className="text-xs text-foreground/60">
          Plan limits are configurable placeholders for this project, not researched market pricing — see
          src/lib/billing/plans.ts.
        </p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {PLAN_IDS.map((id) => {
            const plan = PLANS[id];
            const isCurrent = id === usage.plan.id;
            return (
              <li
                key={id}
                className={
                  "rounded-md border p-4 space-y-2 " +
                  (isCurrent ? "border-foreground/40 bg-foreground/5" : "border-foreground/10")
                }
              >
                <div className="flex items-baseline justify-between">
                  <h3 className="font-medium">{plan.name}</h3>
                  <span className="text-sm text-foreground/60">${plan.priceUsdPerMonth}/mo</span>
                </div>
                <ul className="space-y-0.5 text-xs text-foreground/60">
                  <li>{plan.limits.maxWebsites} website{plan.limits.maxWebsites === 1 ? "" : "s"}</li>
                  <li>
                    {plan.limits.manualCrawlsPerMonth === null
                      ? "Unlimited manual crawls"
                      : `${plan.limits.manualCrawlsPerMonth} manual crawls/month`}
                  </li>
                  <li>{plan.limits.schedulingEnabled ? "Scheduled monitoring" : "No scheduled monitoring"}</li>
                  <li>{plan.limits.aiRecommendationsEnabled ? "AI recommendations" : "Template reports only"}</li>
                </ul>
                {isCurrent ? (
                  <span className="inline-block rounded bg-foreground/10 px-2 py-1 text-xs font-medium">
                    Current plan
                  </span>
                ) : id === "free" ? (
                  <p className="text-xs text-foreground/40">Downgrade to Free via &quot;Manage billing&quot; above.</p>
                ) : (
                  <form action={changePlan}>
                    <input type="hidden" name="plan" value={id satisfies PlanId} />
                    <button
                      type="submit"
                      className="w-full rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
                    >
                      Switch to {plan.name}
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
