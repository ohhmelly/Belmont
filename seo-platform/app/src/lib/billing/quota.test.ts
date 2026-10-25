/**
 * Real proof of plan/quota enforcement (Phase 6), against a real local
 * Postgres: every row here (test orgs, websites, crawl_jobs, subscriptions)
 * is inserted for real and the assertions below call the real
 * src/lib/billing/quota.ts functions — the exact same functions the
 * dashboard server actions (src/app/dashboard/actions.ts) call.
 *
 * See src/app/dashboard/billing-quota.integration.test.ts for the same
 * limits proven through the REAL server actions (addWebsite,
 * triggerCrawl, setWebsiteSchedule) end to end, including the "clear
 * error" wording a user would actually see.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/auth-schema";
import { websites, crawlJobs, subscriptions } from "@/db/app-schema";
import {
  assertCanAddWebsite,
  assertCanRunManualCrawl,
  assertCanSchedule,
  isAiRecommendationsAllowed,
  getOrCreateSubscription,
  countWebsites,
  countManualCrawlsThisMonth,
  currentMonthStartUtc,
  QuotaError,
} from "./quota";
import type { PlanId } from "./plans";

const createdOrgIds: string[] = [];

async function makeOrg(plan: PlanId | null): Promise<string> {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const orgId = `test-org-quota-${uniq}`;
  await db.insert(organizations).values({ id: orgId, name: "Quota Test Org", slug: orgId, createdAt: new Date() });
  if (plan) {
    await db.insert(subscriptions).values({ organizationId: orgId, plan, status: "active" });
  }
  createdOrgIds.push(orgId);
  return orgId;
}

async function makeWebsite(orgId: string, url = "https://example.test/"): Promise<string> {
  const [row] = await db
    .insert(websites)
    .values({ organizationId: orgId, url, verificationToken: "test-token" })
    .returning();
  return row.id;
}

async function makeManualCrawlJob(websiteId: string, createdAt: Date): Promise<void> {
  await db.insert(crawlJobs).values({ websiteId, status: "completed", trigger: "manual", createdAt });
}

afterEach(async () => {
  // Cascading deletes clean up websites/crawl_jobs/subscriptions.
  for (const id of createdOrgIds.splice(0)) {
    await db.delete(organizations).where(eq(organizations.id, id)).catch(() => {});
  }
});

describe("website count limit (assertCanAddWebsite)", () => {
  it("blocks a Free-plan org that already has 1 website (its limit) with a clear error", async () => {
    const orgId = await makeOrg("free");
    await makeWebsite(orgId);

    await expect(assertCanAddWebsite(orgId)).rejects.toThrow(QuotaError);
    await expect(assertCanAddWebsite(orgId)).rejects.toThrow(/Free plan allows up to 1 website/i);
  });

  it("does not block a Free-plan org with 0 websites", async () => {
    const orgId = await makeOrg("free");
    await expect(assertCanAddWebsite(orgId)).resolves.toBeUndefined();
  });

  it("does not block a Professional-plan org at a website count that would block Free", async () => {
    const orgId = await makeOrg("professional");
    await makeWebsite(orgId);
    await makeWebsite(orgId);
    await expect(assertCanAddWebsite(orgId)).resolves.toBeUndefined();
    expect(await countWebsites(orgId)).toBe(2);
  });

  it("still blocks a Professional-plan org once it reaches ITS OWN limit (50)", async () => {
    const orgId = await makeOrg("professional");
    // Insert 50 website rows directly (cheap bulk insert) to reach the
    // real configured limit without 50 round trips.
    await db.insert(websites).values(
      Array.from({ length: 50 }, (_, i) => ({
        organizationId: orgId,
        url: `https://example.test/site-${i}`,
        verificationToken: "test-token",
      }))
    );
    expect(await countWebsites(orgId)).toBe(50);
    await expect(assertCanAddWebsite(orgId)).rejects.toThrow(/Professional plan allows up to 50 websites/i);
  }, 20_000);
});

describe("manual crawl limit (assertCanRunManualCrawl) — Free plan, calendar-month window", () => {
  it("allows the 1st-3rd manual crawl and blocks the 4th within the same UTC month", async () => {
    const orgId = await makeOrg("free");
    const websiteId = await makeWebsite(orgId);
    const now = new Date();

    for (let i = 0; i < 3; i++) {
      await expect(assertCanRunManualCrawl(orgId)).resolves.toBeUndefined();
      await makeManualCrawlJob(websiteId, now);
    }

    expect(await countManualCrawlsThisMonth(orgId, now)).toBe(3);
    await expect(assertCanRunManualCrawl(orgId)).rejects.toThrow(QuotaError);
    await expect(assertCanRunManualCrawl(orgId)).rejects.toThrow(/3 manual crawls per calendar month/i);
  });

  it("does not count a manual crawl from a previous UTC month", async () => {
    const orgId = await makeOrg("free");
    const websiteId = await makeWebsite(orgId);
    const now = new Date();
    const lastMonth = new Date(currentMonthStartUtc(now).getTime() - 24 * 60 * 60 * 1000);

    await makeManualCrawlJob(websiteId, lastMonth);
    await makeManualCrawlJob(websiteId, lastMonth);
    await makeManualCrawlJob(websiteId, lastMonth);

    expect(await countManualCrawlsThisMonth(orgId, now)).toBe(0);
    await expect(assertCanRunManualCrawl(orgId)).resolves.toBeUndefined();
  });

  it("does not count a SCHEDULED crawl toward the manual quota", async () => {
    const orgId = await makeOrg("free");
    const websiteId = await makeWebsite(orgId);
    await db.insert(crawlJobs).values({ websiteId, status: "completed", trigger: "scheduled", createdAt: new Date() });
    expect(await countManualCrawlsThisMonth(orgId)).toBe(0);
  });

  it("is unlimited on Starter/Professional/Agency", async () => {
    for (const plan of ["starter", "professional", "agency"] as PlanId[]) {
      const orgId = await makeOrg(plan);
      const websiteId = await makeWebsite(orgId);
      for (let i = 0; i < 5; i++) await makeManualCrawlJob(websiteId, new Date());
      await expect(assertCanRunManualCrawl(orgId)).resolves.toBeUndefined();
    }
  });
});

describe("scheduling gate (assertCanSchedule) — Free plan has no scheduled monitoring", () => {
  it("refuses a Free-plan org trying to set any schedule other than 'none'", async () => {
    const orgId = await makeOrg("free");
    await expect(assertCanSchedule(orgId, "daily")).rejects.toThrow(QuotaError);
    await expect(assertCanSchedule(orgId, "daily")).rejects.toThrow(/aren't included in your Free plan/i);
    await expect(assertCanSchedule(orgId, "weekly")).rejects.toThrow(QuotaError);
    await expect(assertCanSchedule(orgId, "monthly")).rejects.toThrow(QuotaError);
  });

  it("always allows 'none' (disabling) regardless of plan", async () => {
    const orgId = await makeOrg("free");
    await expect(assertCanSchedule(orgId, "none")).resolves.toBeUndefined();
  });

  it("allows a Starter-plan org to set a schedule", async () => {
    const orgId = await makeOrg("starter");
    await expect(assertCanSchedule(orgId, "daily")).resolves.toBeUndefined();
  });
});

describe("AI recommendations gate", () => {
  it("is disabled on Free and Starter, enabled on Professional and Agency", async () => {
    expect(await isAiRecommendationsAllowed(await makeOrg("free"))).toBe(false);
    expect(await isAiRecommendationsAllowed(await makeOrg("starter"))).toBe(false);
    expect(await isAiRecommendationsAllowed(await makeOrg("professional"))).toBe(true);
    expect(await isAiRecommendationsAllowed(await makeOrg("agency"))).toBe(true);
  });
});

describe("getOrCreateSubscription", () => {
  it("lazily creates exactly one Free-plan row, even under a concurrent race", async () => {
    const orgId = await makeOrg(null); // no subscription row created yet

    const [a, b] = await Promise.all([getOrCreateSubscription(orgId), getOrCreateSubscription(orgId)]);
    expect(a.plan).toBe("free");
    expect(b.id).toBe(a.id); // same row, not two different inserts

    const rows = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    expect(rows).toHaveLength(1);
  });
});
