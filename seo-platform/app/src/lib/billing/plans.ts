/**
 * Plan definitions (Phase 6).
 *
 * IMPORTANT — these numbers are CONFIGURABLE PLACEHOLDERS, not researched
 * market pricing. The original project spec is explicit that Free/Starter
 * ($49)/Professional ($149)/Agency ($299) are illustrative tiers
 * ("limited", "multiple", "higher" usage), not validated prices. The
 * numeric limits below are our own reasonable translation of those words
 * into enforceable numbers, picked for this implementation — change them
 * here, in one place, with no migration required, whenever the business
 * decides on real numbers.
 *
 * Plan -> feature mapping, as translated from the spec:
 *   Free         — 1 website, limited manual audits, basic reports.
 *                  -> maxWebsites: 1, manualCrawlsPerMonth: 3,
 *                     schedulingEnabled: false, aiRecommendationsEnabled: false.
 *   Starter $49  — multiple websites, scheduled monitoring, downloadable reports.
 *                  -> maxWebsites: 10, manualCrawlsPerMonth: unlimited,
 *                     schedulingEnabled: true, aiRecommendationsEnabled: false.
 *   Professional $149 — higher crawl allowances, AI recommendations,
 *                  branded reports, additional monitoring.
 *                  -> maxWebsites: 50, manualCrawlsPerMonth: unlimited,
 *                     schedulingEnabled: true, aiRecommendationsEnabled: true.
 *   Agency $299  — multiple client organizations, higher usage limits,
 *                  advanced reporting, team access.
 *                  -> maxWebsites: 200, manualCrawlsPerMonth: unlimited,
 *                     schedulingEnabled: true, aiRecommendationsEnabled: true.
 *                  ("multiple client organizations" / "team access" are
 *                  already supported structurally by Better Auth's
 *                  `organization` plugin — any user can belong to/create
 *                  several orgs today; this plan does not add a NEW
 *                  mechanism for that, it just raises the per-org limits
 *                  an Agency-tier org gets.)
 *
 * Manual-crawl quota window: calendar month in UTC (resets on the 1st of
 * each month at 00:00 UTC), not a rolling 30 days — simpler to reason
 * about and to test deterministically. Documented here as the one place
 * this choice is made; see `countManualCrawlsThisMonth` in quota.ts.
 */

export type PlanId = "free" | "starter" | "professional" | "agency";

export const PLAN_IDS: PlanId[] = ["free", "starter", "professional", "agency"];

export interface PlanLimits {
  /** Maximum number of websites an organization on this plan may have. */
  maxWebsites: number;
  /**
   * Maximum number of MANUALLY-triggered crawls (addWebsite's automatic
   * first crawl counts as one) per calendar month (UTC). `null` means
   * unlimited.
   */
  manualCrawlsPerMonth: number | null;
  /** Whether a website on this plan may be given a non-"none" recurring audit schedule. */
  schedulingEnabled: boolean;
  /**
   * Whether this plan gets real AI-generated recommendations (when an AI
   * provider is configured/reachable). Plans without this still get a
   * full report with deterministic TEMPLATE recommendations — they are
   * never left with nothing — they just never get a real model call.
   */
  aiRecommendationsEnabled: boolean;
}

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Illustrative only — see file header. USD/month, 0 for Free. */
  priceUsdPerMonth: number;
  limits: PlanLimits;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    priceUsdPerMonth: 0,
    limits: {
      maxWebsites: 1,
      manualCrawlsPerMonth: 3,
      schedulingEnabled: false,
      aiRecommendationsEnabled: false,
    },
  },
  starter: {
    id: "starter",
    name: "Starter",
    priceUsdPerMonth: 49,
    limits: {
      maxWebsites: 10,
      manualCrawlsPerMonth: null,
      schedulingEnabled: true,
      aiRecommendationsEnabled: false,
    },
  },
  professional: {
    id: "professional",
    name: "Professional",
    priceUsdPerMonth: 149,
    limits: {
      maxWebsites: 50,
      manualCrawlsPerMonth: null,
      schedulingEnabled: true,
      aiRecommendationsEnabled: true,
    },
  },
  agency: {
    id: "agency",
    name: "Agency",
    priceUsdPerMonth: 299,
    limits: {
      maxWebsites: 200,
      manualCrawlsPerMonth: null,
      schedulingEnabled: true,
      aiRecommendationsEnabled: true,
    },
  },
};

export function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as string[]).includes(value);
}

export function getPlanDefinition(plan: string): PlanDefinition {
  return isPlanId(plan) ? PLANS[plan] : PLANS.free;
}
