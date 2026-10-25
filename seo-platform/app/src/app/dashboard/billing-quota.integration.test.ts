/**
 * Real proof that plan/quota enforcement is wired into the actual
 * dashboard server actions (Phase 6) — not just the quota.ts helpers
 * tested in isolation (src/lib/billing/quota.test.ts). This calls the
 * REAL `addWebsite`, `triggerCrawl`, and `setWebsiteSchedule` functions
 * exported from ./actions, against a real local Postgres, and asserts
 * the exact user-facing error message a blocked org would see.
 *
 * Uses real Better Auth sessions via src/lib/test-support/auth-fixtures.ts
 * (same technique as cancel.test.ts / cross-org-isolation.test.ts /
 * role-enforcement.test.ts): each server action is called with an
 * explicit `headersOverride` carrying a real signed-in user's session
 * cookie, so the real org-ownership (require-org-access.ts) AND quota
 * (quota.ts) checks both run for real against this test's own rows —
 * nothing about authorization is mocked.
 *
 * `@/lib/crawl-safety`'s `validateUrlForCrawl` is also mocked to always
 * succeed, SOLELY so `addWebsite` doesn't need a real externally-
 * reachable URL / outbound network call in this test — that network
 * safety behavior is already proven for real in crawl-safety.test.ts and
 * is explicitly out of scope for this phase. `CrawlSafetyError` itself is
 * re-exported from the real module (via importOriginal) so
 * `addWebsite`'s own `instanceof CrawlSafetyError` check still works
 * correctly against the real class.
 *
 * `addWebsite`/`setWebsiteSchedule` call `revalidatePath()`/`redirect()`
 * on success. Called directly from a test (no real Next.js request
 * scope), `revalidatePath()` itself throws "Invariant: static
 * generation store missing in revalidatePath(...)" BEFORE `redirect()`
 * is ever reached — the exact same test-harness artifact already
 * documented and tolerated in src/lib/jobs/cancel.test.ts (not a failure
 * of anything this test is proving: the action's real work — the DB
 * writes, the quota check — already happened by the time that throw
 * fires). `expectSuccess` below tolerates ONLY that specific error
 * message and re-throws anything else (e.g. a real QuotaError), so a
 * genuine regression still fails the test.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "@/db";
import { organizations } from "@/db/auth-schema";
import { websites, crawlJobs, subscriptions } from "@/db/app-schema";
import type { PlanId } from "@/lib/billing/plans";
import { createUserAndOrg } from "@/lib/test-support/auth-fixtures";

vi.mock("@/lib/crawl-safety", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crawl-safety")>();
  return {
    ...actual,
    validateUrlForCrawl: async (rawUrl: string) => ({
      url: new URL(rawUrl),
      target: { hostname: new URL(rawUrl).hostname, address: "93.184.216.34", family: 4 as const },
    }),
  };
});

const { addWebsite, triggerCrawl, setWebsiteSchedule } = await import("./actions");

/** Real user + real org (owner session) via Better Auth, with a subscription row set to the given plan. */
async function makeOrg(plan: PlanId): Promise<{ orgId: string; headers: Headers }> {
  const owner = await createUserAndOrg(`BillingQuota-${plan}`);
  await db.insert(subscriptions).values({ organizationId: owner.organizationId, plan, status: "active" });
  return { orgId: owner.organizationId, headers: owner.headers };
}

async function cleanup(orgId: string) {
  // Hygiene: a real crawl-website/scheduled-audit-trigger pg-boss job may
  // have been enqueued for this org's website(s) (addWebsite/
  // setWebsiteSchedule do this for real) and isn't FK-constrained to the
  // websites table, so cascading the org delete below won't remove it —
  // same orphaned-job situation documented in jobs/schedule.test.ts.
  // Not a correctness issue (it just fails cleanly later on the
  // now-missing FK), but cleaned up so it doesn't clutter the real queue.
  const orgWebsites = await db.select({ id: websites.id }).from(websites).where(eq(websites.organizationId, orgId));
  for (const { id } of orgWebsites) {
    await pool
      .query(`DELETE FROM pgboss.job WHERE name IN ('crawl-website', 'scheduled-audit-trigger') AND data->>'websiteId' = $1`, [id])
      .catch(() => {});
  }
  await db.delete(organizations).where(eq(organizations.id, orgId)).catch(() => {});
}

afterAll(async () => {
  await pool.end();
});

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/**
 * Awaits a server action that is expected to SUCCEED. Tolerates only the
 * "static generation store missing" revalidatePath/redirect artifact of
 * calling a "use server" action directly outside a real Next.js request
 * (see file header and src/lib/jobs/cancel.test.ts) — any other
 * rejection (e.g. a real QuotaError) is a genuine failure and is
 * re-thrown so this helper can never mask a real regression.
 */
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

describe("quota enforcement through the real dashboard server actions", () => {
  it("real addWebsite call: refuses a Free-plan org already at its 1-website limit, with a clear error", async () => {
    const { orgId, headers } = await makeOrg("free");
    try {
      // First website succeeds (org starts at 0) — proves addWebsite's
      // success path too, not just the blocked path.
      await expectSuccess(addWebsite(formData({ url: "https://example.com/" }), headers));

      const sitesAfterFirst = await db.select().from(websites).where(eq(websites.organizationId, orgId));
      expect(sitesAfterFirst).toHaveLength(1);

      // Second website is refused — org is now at its Free-plan limit.
      await expect(addWebsite(formData({ url: "https://example.org/" }), headers)).rejects.toThrow(
        /Free plan allows up to 1 website/i
      );

      // Confirm nothing was created by the refused attempt.
      const sitesAfterSecond = await db.select().from(websites).where(eq(websites.organizationId, orgId));
      expect(sitesAfterSecond).toHaveLength(1);
    } finally {
      await cleanup(orgId);
    }
  });

  it("real addWebsite call: a Professional-plan org is NOT limited at a count that would block Free", async () => {
    const { orgId, headers } = await makeOrg("professional");
    try {
      await expectSuccess(addWebsite(formData({ url: "https://example.com/" }), headers));
      await expectSuccess(addWebsite(formData({ url: "https://example.net/" }), headers));

      const sites = await db.select().from(websites).where(eq(websites.organizationId, orgId));
      expect(sites).toHaveLength(2);
    } finally {
      await cleanup(orgId);
    }
  });

  it("real triggerCrawl call: refuses the 4th manual crawl in a month for a Free-plan org", async () => {
    const { orgId, headers } = await makeOrg("free");
    try {
      const [website] = await db
        .insert(websites)
        .values({ organizationId: orgId, url: "http://127.0.0.1:1/", verificationToken: "test-token" })
        .returning();

      // 3 manual crawls already run this month (inserted directly —
      // irrelevant that they're not "completed", only trigger+createdAt
      // matter to the quota check).
      await db.insert(crawlJobs).values([
        { websiteId: website.id, status: "completed", trigger: "manual" },
        { websiteId: website.id, status: "completed", trigger: "manual" },
        { websiteId: website.id, status: "completed", trigger: "manual" },
      ]);

      await expect(triggerCrawl(formData({ websiteId: website.id }), headers)).rejects.toThrow(
        /3 manual crawls per calendar month/i
      );

      // Refused attempt must not have created a 4th crawl_jobs row.
      const jobs = await db.select().from(crawlJobs).where(eq(crawlJobs.websiteId, website.id));
      expect(jobs).toHaveLength(3);
    } finally {
      await cleanup(orgId);
    }
  });

  it("real setWebsiteSchedule call: refuses a Free-plan org trying to enable scheduling", async () => {
    const { orgId, headers } = await makeOrg("free");
    try {
      const [website] = await db
        .insert(websites)
        .values({ organizationId: orgId, url: "http://127.0.0.1:1/", verificationToken: "test-token" })
        .returning();

      await expect(
        setWebsiteSchedule(formData({ websiteId: website.id, cadence: "daily" }), headers)
      ).rejects.toThrow(/aren't included in your Free plan/i);

      const [row] = await db.select().from(websites).where(eq(websites.id, website.id));
      expect(row.auditSchedule).toBe("none"); // unchanged by the refused attempt

      // "none" is always allowed, even on Free.
      await expectSuccess(setWebsiteSchedule(formData({ websiteId: website.id, cadence: "none" }), headers));
    } finally {
      await cleanup(orgId);
    }
  });

  it("real setWebsiteSchedule call: a Starter-plan org CAN enable scheduling", async () => {
    const { orgId, headers } = await makeOrg("starter");
    try {
      const [website] = await db
        .insert(websites)
        .values({ organizationId: orgId, url: "http://127.0.0.1:1/", verificationToken: "test-token" })
        .returning();

      await expectSuccess(setWebsiteSchedule(formData({ websiteId: website.id, cadence: "weekly" }), headers));

      const [row] = await db.select().from(websites).where(eq(websites.id, website.id));
      expect(row.auditSchedule).toBe("weekly");

      // Clean up the real pg-boss schedule entry setWebsiteSchedule installed.
      const { applyWebsiteSchedule } = await import("@/lib/queue");
      await applyWebsiteSchedule(website.id, "none");
    } finally {
      await cleanup(orgId);
    }
  });
});
