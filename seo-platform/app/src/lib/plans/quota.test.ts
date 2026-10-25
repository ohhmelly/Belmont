/**
 * Real proof of plan-quota enforcement (Phase 6): a free-plan org is
 * blocked from adding a 2nd website (its plan's `maxWebsites` limit),
 * while a higher-tier org is not blocked at the same count — both
 * exercised through the real `addWebsite` server action (which also
 * enqueues a real pg-boss job on success), against a real Postgres
 * database, with real Better Auth sessions.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { websites } from "@/db/app-schema";
import { orgPlans } from "@/db/app-schema";
import { createUserAndOrg } from "@/lib/test-support/auth-fixtures";
import { addWebsite, triggerCrawl } from "@/app/dashboard/actions";
import { QuotaExceededError } from "./quota";

async function addWebsiteFormData(url: string): Promise<FormData> {
  const fd = new FormData();
  fd.set("url", url);
  return fd;
}

describe("Phase 6 plan quotas (real DB, real actions)", () => {
  it("blocks a free-plan org from adding a 2nd website", async () => {
    const org = await createUserAndOrg("QuotaFree-Owner");

    // 1st website: free plan allows exactly 1 -> succeeds (redirect()
    // throws outside a real Next.js request; that's the only acceptable
    // rejection reason here).
    try {
      await addWebsite(await addWebsiteFormData("https://quota-free-1.example"), org.headers);
    } catch (err) {
      if (!(err instanceof Error) || !/NEXT_REDIRECT|static generation store/.test(err.message)) throw err;
    }

    const afterFirst = await db.select().from(websites).where(eq(websites.organizationId, org.organizationId));
    expect(afterFirst.length).toBe(1);

    // 2nd website: must be rejected by the quota check BEFORE any row is
    // inserted.
    await expect(
      addWebsite(await addWebsiteFormData("https://quota-free-2.example"), org.headers)
    ).rejects.toBeInstanceOf(QuotaExceededError);

    const afterSecond = await db.select().from(websites).where(eq(websites.organizationId, org.organizationId));
    expect(afterSecond.length).toBe(1); // unchanged — the rejected attempt left no row behind
  });

  it("does not block a starter-plan org at the same (2nd website) threshold", async () => {
    const org = await createUserAndOrg("QuotaStarter-Owner");
    await db.insert(orgPlans).values({ organizationId: org.organizationId, plan: "starter", status: "active" });

    try {
      await addWebsite(await addWebsiteFormData("https://quota-starter-1.example"), org.headers);
    } catch (err) {
      if (!(err instanceof Error) || !/NEXT_REDIRECT|static generation store/.test(err.message)) throw err;
    }
    try {
      await addWebsite(await addWebsiteFormData("https://quota-starter-2.example"), org.headers);
    } catch (err) {
      if (!(err instanceof Error) || !/NEXT_REDIRECT|static generation store/.test(err.message)) throw err;
    }

    const afterBoth = await db.select().from(websites).where(eq(websites.organizationId, org.organizationId));
    expect(afterBoth.length).toBe(2); // starter plan's maxWebsites (5) was not hit, so neither call was blocked
  });

  it("blocks a free-plan org's 4th manual crawl this month (limit is 3/month, counting addWebsite's own crawl)", async () => {
    const org = await createUserAndOrg("QuotaCrawl-Owner");

    // addWebsite's own enqueued crawl is manual crawl #1.
    try {
      await addWebsite(await addWebsiteFormData("https://quota-crawl.example"), org.headers);
    } catch (err) {
      if (!(err instanceof Error) || !/NEXT_REDIRECT|static generation store/.test(err.message)) throw err;
    }
    const [website] = await db.select().from(websites).where(eq(websites.organizationId, org.organizationId));

    const triggerFormData = () => {
      const fd = new FormData();
      fd.set("websiteId", website.id);
      return fd;
    };

    // Manual crawls #2 and #3 succeed (free plan allows 3/month total).
    // revalidatePath() throws outside a real Next.js request; the crawl
    // itself (asserted via the quota count below) already ran by then.
    const runTriggerCrawl = async () => {
      try {
        await triggerCrawl(triggerFormData(), org.headers);
      } catch (err) {
        if (!(err instanceof Error) || !/static generation store/.test(err.message)) throw err;
      }
    };
    await runTriggerCrawl();
    await runTriggerCrawl();

    // Manual crawl #4 is over the limit.
    await expect(triggerCrawl(triggerFormData(), org.headers)).rejects.toBeInstanceOf(QuotaExceededError);
  });
});
