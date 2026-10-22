/**
 * Plan/quota enforcement (Phase 6). This is the ONE place that decides
 * whether an organization is allowed to add a website, run a manual
 * crawl, or turn on a recurring schedule — every call site (dashboard
 * server actions today, anything else later) must go through these
 * helpers rather than re-implementing the check inline, exactly the same
 * principle `src/lib/tenant.ts` established for ownership checks.
 */
import { and, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { subscriptions, websites, crawlJobs } from "@/db/app-schema";
import { getPlanDefinition, type PlanDefinition } from "./plans";

export class QuotaError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = "QuotaError";
    this.status = status;
  }
}

export type SubscriptionRow = typeof subscriptions.$inferSelect;

/**
 * Loads an organization's subscription row, lazily creating a Free-plan
 * row the first time one is asked for (see the table comment in
 * app-schema.ts for why this is lazy rather than hooked into org
 * creation). Safe to call concurrently: a unique constraint on
 * `organizationId` means a race just hits `onConflictDoNothing` on one
 * side and a plain re-read on the other.
 */
export async function getOrCreateSubscription(organizationId: string): Promise<SubscriptionRow> {
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId));
  if (existing) return existing;

  const inserted = await db
    .insert(subscriptions)
    .values({ organizationId, plan: "free", status: "active" })
    .onConflictDoNothing({ target: subscriptions.organizationId })
    .returning();
  if (inserted[0]) return inserted[0];

  // Lost the race — someone else's insert won; read what they created.
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId));
  if (!row) throw new Error(`Failed to load or create subscription for org ${organizationId}`);
  return row;
}

export async function getOrgPlan(organizationId: string): Promise<PlanDefinition> {
  const sub = await getOrCreateSubscription(organizationId);
  return getPlanDefinition(sub.plan);
}

export async function countWebsites(organizationId: string): Promise<number> {
  const rows = await db
    .select({ id: websites.id })
    .from(websites)
    .where(eq(websites.organizationId, organizationId));
  return rows.length;
}

/** Start of the current UTC calendar month — see plans.ts for why this window was chosen. */
export function currentMonthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Manually-triggered crawls (trigger="manual", which includes a new
 * website's automatic first crawl) for this org since the start of the
 * current UTC calendar month. Scheduled crawls never count against this
 * — they're gated separately by `assertSchedulingAllowed`.
 */
export async function countManualCrawlsThisMonth(organizationId: string, now: Date = new Date()): Promise<number> {
  const monthStart = currentMonthStartUtc(now);
  const rows = await db
    .select({ id: crawlJobs.id })
    .from(crawlJobs)
    .innerJoin(websites, eq(crawlJobs.websiteId, websites.id))
    .where(
      and(
        eq(websites.organizationId, organizationId),
        eq(crawlJobs.trigger, "manual"),
        gte(crawlJobs.createdAt, monthStart)
      )
    );
  return rows.length;
}

/** Throws a clear QuotaError if adding one more website would exceed the org's plan limit. */
export async function assertCanAddWebsite(organizationId: string): Promise<void> {
  const plan = await getOrgPlan(organizationId);
  const current = await countWebsites(organizationId);
  if (current >= plan.limits.maxWebsites) {
    throw new QuotaError(
      `Your ${plan.name} plan allows up to ${plan.limits.maxWebsites} website${plan.limits.maxWebsites === 1 ? "" : "s"}, and you already have ${current}. Upgrade your plan to add more.`
    );
  }
}

/** Throws a clear QuotaError if this org has used up its manual-crawl quota for the current month. */
export async function assertCanRunManualCrawl(organizationId: string): Promise<void> {
  const plan = await getOrgPlan(organizationId);
  const limit = plan.limits.manualCrawlsPerMonth;
  if (limit === null) return; // unlimited on this plan
  const used = await countManualCrawlsThisMonth(organizationId);
  if (used >= limit) {
    throw new QuotaError(
      `Your ${plan.name} plan allows ${limit} manual crawl${limit === 1 ? "" : "s"} per calendar month, and you've already run ${used} this month. Upgrade your plan or wait until next month.`
    );
  }
}

/** Throws a clear QuotaError if this org's plan doesn't include recurring scheduled monitoring. */
export async function assertCanSchedule(organizationId: string, cadence: string): Promise<void> {
  if (cadence === "none") return; // disabling a schedule is always allowed
  const plan = await getOrgPlan(organizationId);
  if (!plan.limits.schedulingEnabled) {
    throw new QuotaError(
      `Recurring scheduled audits aren't included in your ${plan.name} plan. Upgrade to Starter or above to enable scheduling.`
    );
  }
}

/** Whether this org's plan includes real AI-generated recommendations (vs. template-only). */
export async function isAiRecommendationsAllowed(organizationId: string): Promise<boolean> {
  const plan = await getOrgPlan(organizationId);
  return plan.limits.aiRecommendationsEnabled;
}

export interface UsageSummary {
  plan: PlanDefinition;
  websiteCount: number;
  manualCrawlsThisMonth: number;
  status: string;
}

/** Everything the billing dashboard page needs about an org's current usage, in one call. */
export async function getUsageSummary(organizationId: string): Promise<UsageSummary> {
  const sub = await getOrCreateSubscription(organizationId);
  const plan = getPlanDefinition(sub.plan);
  const [websiteCount, manualCrawlsThisMonth] = await Promise.all([
    countWebsites(organizationId),
    countManualCrawlsThisMonth(organizationId),
  ]);
  return { plan, websiteCount, manualCrawlsThisMonth, status: sub.status };
}
