/**
 * Quota enforcement (Phase 6). Thin wrappers around src/lib/plans/limits.ts
 * that actually count current usage and throw a clear, user-facing
 * QuotaExceededError when an org is over its plan's limit — used by the
 * server actions that create a website or enqueue a manual crawl so the
 * limit is enforced server-side, not just hidden in the UI.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { websites, crawlJobs } from "@/db/app-schema";
import { getOrgPlan, type PlanLimits } from "./limits";

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

/** Start of the current UTC calendar month, used as the rolling-window floor for the manual-crawl quota. */
function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function countOrgWebsites(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(websites)
    .where(eq(websites.organizationId, organizationId));
  return Number(row?.count ?? 0);
}

/** Count manual crawls (any status) across every website this org owns, since the start of the current UTC month. */
export async function countOrgManualCrawlsThisMonth(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(crawlJobs)
    .innerJoin(websites, eq(crawlJobs.websiteId, websites.id))
    .where(
      and(
        eq(websites.organizationId, organizationId),
        eq(crawlJobs.trigger, "manual"),
        gte(crawlJobs.createdAt, startOfCurrentMonthUtc())
      )
    );
  return Number(row?.count ?? 0);
}

/** Throws QuotaExceededError if adding one more website would exceed this org's plan. Returns the limits otherwise (callers that also need them don't have to fetch twice). */
export async function assertCanAddWebsite(organizationId: string): Promise<PlanLimits> {
  const { plan, limits } = await getOrgPlan(organizationId);
  const current = await countOrgWebsites(organizationId);
  if (current >= limits.maxWebsites) {
    throw new QuotaExceededError(
      `The ${limits.label} plan allows at most ${limits.maxWebsites} website(s); this organization already has ${current}. Upgrade the plan to add more.`
    );
  }
  void plan;
  return limits;
}

/** Throws QuotaExceededError if one more manual crawl this month would exceed this org's plan. */
export async function assertCanTriggerManualCrawl(organizationId: string): Promise<PlanLimits> {
  const { limits } = await getOrgPlan(organizationId);
  const current = await countOrgManualCrawlsThisMonth(organizationId);
  if (current >= limits.maxManualCrawlsPerMonth) {
    throw new QuotaExceededError(
      `The ${limits.label} plan allows at most ${limits.maxManualCrawlsPerMonth} manual crawl(s) per month; this organization has already used ${current} this month. Upgrade the plan to run more.`
    );
  }
  return limits;
}

/** Throws QuotaExceededError if this org's plan does not allow recurring (non-"none") schedules at all. */
export async function assertSchedulingAllowed(organizationId: string): Promise<PlanLimits> {
  const { limits } = await getOrgPlan(organizationId);
  if (!limits.schedulingAllowed) {
    throw new QuotaExceededError(
      `The ${limits.label} plan does not include scheduled/recurring audits. Upgrade the plan to enable scheduling.`
    );
  }
  return limits;
}
