/**
 * Plan/quota definitions (Phase 6).
 *
 * IMPORTANT: these tier names, limits and (nonexistent, see
 * src/lib/billing/stripe-client.ts) prices are EXAMPLE/CONFIGURABLE
 * values taken from this project's own spec as a reasonable starting
 * point for a self-hosted SEO SaaS. They are NOT validated market
 * pricing and NOT a final business decision — change them here (one
 * place) rather than hunting for magic numbers scattered through the
 * app, and treat them as placeholders until a real pricing study informs
 * otherwise.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgPlans } from "@/db/app-schema";

export const PLAN_IDS = ["free", "starter", "professional", "agency"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}

export interface PlanLimits {
  /** Human label for the dashboard. */
  label: string;
  /** Max number of websites this org may have registered at once. */
  maxWebsites: number;
  /** Max MANUAL crawls (user clicked "Run crawl", including the one `addWebsite` enqueues) per rolling calendar month, org-wide. */
  maxManualCrawlsPerMonth: number;
  /** Whether a recurring (daily/weekly/monthly) audit schedule may be turned on for any website in this org. */
  schedulingAllowed: boolean;
  /** Whether AI-generated recommendations may be produced (vs. template-only fallback) when generating a report. */
  aiRecommendationsAllowed: boolean;
  /** Whether reports may show the org's own branding instead of the default template. (Flag only — no branding UI yet.) */
  brandedReports: boolean;
}

/**
 * Example starting-point limits, per the Phase 6 spec:
 *  - Free: 1 website, 3 manual audits/month, no scheduling.
 *  - Starter: multiple websites, scheduled monitoring allowed.
 *  - Professional: higher crawl allowance, AI recommendations, branded reports.
 *  - Agency: highest per-org limits (multi-org support is a stretch goal
 *    not implemented — "agency" here just means the largest single-org
 *    ceiling).
 */
export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    label: "Free",
    maxWebsites: 1,
    maxManualCrawlsPerMonth: 3,
    schedulingAllowed: false,
    aiRecommendationsAllowed: true,
    brandedReports: false,
  },
  starter: {
    label: "Starter",
    maxWebsites: 5,
    maxManualCrawlsPerMonth: 30,
    schedulingAllowed: true,
    aiRecommendationsAllowed: true,
    brandedReports: false,
  },
  professional: {
    label: "Professional",
    maxWebsites: 20,
    maxManualCrawlsPerMonth: 200,
    schedulingAllowed: true,
    aiRecommendationsAllowed: true,
    brandedReports: true,
  },
  agency: {
    label: "Agency",
    maxWebsites: 100,
    maxManualCrawlsPerMonth: 1000,
    schedulingAllowed: true,
    aiRecommendationsAllowed: true,
    brandedReports: true,
  },
};

export interface OrgPlanState {
  plan: PlanId;
  status: string;
  limits: PlanLimits;
}

/** An org with no `org_plans` row at all is on the free plan — see org_plans' doc comment in app-schema.ts. */
export async function getOrgPlan(organizationId: string): Promise<OrgPlanState> {
  const [row] = await db.select().from(orgPlans).where(eq(orgPlans.organizationId, organizationId));
  const plan: PlanId = row && isPlanId(row.plan) ? row.plan : "free";
  return { plan, status: row?.status ?? "active", limits: PLAN_LIMITS[plan] };
}
