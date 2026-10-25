/**
 * Phase 7 security fix: prove the real `triggerCrawl` server action
 * enforces a per-user BURST cap on manual crawls, on top of (and
 * independent from) the monthly plan quota already proven in
 * billing-quota.integration.test.ts.
 *
 * Why this exists: `assertCanRunManualCrawl` only blocks once a whole
 * calendar month's quota is used up. Nothing previously stopped a
 * single user from firing `triggerCrawl` dozens of times in the same
 * second — each one inserting a `crawl_jobs` row and spawning a real
 * siteone-crawler subprocess on the worker — as long as they were still
 * under the monthly ceiling. This test uses the Starter plan
 * (`manualCrawlsPerMonth: null`, i.e. unlimited) specifically so the
 * monthly quota check can never be what blocks these calls — only the
 * new burst limiter in `src/lib/rate-limit.ts` can.
 *
 * Uses the same real-session/real-Postgres technique as
 * billing-quota.integration.test.ts (no mocking of auth, quota, or the
 * rate limiter itself) — `enqueueCrawl` really talks to the real
 * pg-boss-backed queue in this sandbox's Postgres.
 */
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "@/db";
import { organizations } from "@/db/auth-schema";
import { websites, crawlJobs, subscriptions } from "@/db/app-schema";
import { createUserAndOrg } from "@/lib/test-support/auth-fixtures";
import { __resetRateLimitsForTests } from "@/lib/rate-limit";
import { triggerCrawl } from "./actions";

beforeEach(() => {
  __resetRateLimitsForTests();
});

afterAll(async () => {
  await pool.end();
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function expectSuccess(promise: Promise<void>): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const digest = (err as { digest?: string }).digest;
    const isHarnessArtifact =
      digest?.startsWith("NEXT_REDIRECT") ||
      (err instanceof Error && err.message.includes("static generation store missing"));
    if (!isHarnessArtifact) throw err;
  }
}

async function cleanup(orgId: string) {
  const orgWebsites = await db.select({ id: websites.id }).from(websites).where(eq(websites.organizationId, orgId));
  for (const { id } of orgWebsites) {
    await pool
      .query(`DELETE FROM pgboss.job WHERE name IN ('crawl-website', 'scheduled-audit-trigger') AND data->>'websiteId' = $1`, [id])
      .catch(() => {});
  }
  await db.delete(organizations).where(eq(organizations.id, orgId)).catch(() => {});
}

describe("manual crawl burst rate limiting (triggerCrawl)", () => {
  it("allows up to the burst limit, then rejects further triggers within the same window — even on an unlimited-quota plan", async () => {
    const owner = await createUserAndOrg("CrawlBurst");
    await db.insert(subscriptions).values({ organizationId: owner.organizationId, plan: "starter", status: "active" });
    try {
      const [website] = await db
        .insert(websites)
        .values({ organizationId: owner.organizationId, url: "http://127.0.0.1:1/", verificationToken: "test-token" })
        .returning();

      // First 10 triggers succeed (the burst budget).
      for (let i = 0; i < 10; i++) {
        await expectSuccess(triggerCrawl(formData({ websiteId: website.id }), owner.headers));
      }
      const jobsAfterTen = await db.select().from(crawlJobs).where(eq(crawlJobs.websiteId, website.id));
      expect(jobsAfterTen).toHaveLength(10);

      // The 11th, in the same burst window, must be rejected — proving
      // the monthly quota (unlimited on Starter) is NOT what's doing the
      // blocking here.
      await expect(triggerCrawl(formData({ websiteId: website.id }), owner.headers)).rejects.toThrow(
        /too many requests/i
      );

      // The refused attempt must not have created an 11th crawl_jobs row.
      const jobsAfterEleven = await db.select().from(crawlJobs).where(eq(crawlJobs.websiteId, website.id));
      expect(jobsAfterEleven).toHaveLength(10);
    } finally {
      await cleanup(owner.organizationId);
    }
  }, 30_000);

  it("gives a different user their own independent burst budget", async () => {
    const ownerA = await createUserAndOrg("CrawlBurstA");
    await db.insert(subscriptions).values({ organizationId: ownerA.organizationId, plan: "starter", status: "active" });
    const ownerB = await createUserAndOrg("CrawlBurstB");
    await db.insert(subscriptions).values({ organizationId: ownerB.organizationId, plan: "starter", status: "active" });
    try {
      const [siteA] = await db
        .insert(websites)
        .values({ organizationId: ownerA.organizationId, url: "http://127.0.0.1:1/", verificationToken: "t" })
        .returning();
      const [siteB] = await db
        .insert(websites)
        .values({ organizationId: ownerB.organizationId, url: "http://127.0.0.1:1/", verificationToken: "t" })
        .returning();

      // Exhaust user A's burst budget.
      for (let i = 0; i < 10; i++) {
        await expectSuccess(triggerCrawl(formData({ websiteId: siteA.id }), ownerA.headers));
      }
      await expect(triggerCrawl(formData({ websiteId: siteA.id }), ownerA.headers)).rejects.toThrow(
        /too many requests/i
      );

      // User B, a completely different person, must be unaffected.
      await expectSuccess(triggerCrawl(formData({ websiteId: siteB.id }), ownerB.headers));
      const jobsB = await db.select().from(crawlJobs).where(eq(crawlJobs.websiteId, siteB.id));
      expect(jobsB).toHaveLength(1);
    } finally {
      await cleanup(ownerA.organizationId);
      await cleanup(ownerB.organizationId);
    }
  }, 30_000);
});
