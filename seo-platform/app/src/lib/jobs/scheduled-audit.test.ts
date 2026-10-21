/**
 * Real proof of the two "avoid unnecessary re-crawling" guards in
 * scheduled-audit.ts (spec section 7):
 *
 *  1. The minimum-interval floor — proven end-to-end against real
 *     Postgres: a website whose last scheduled crawl was "just now" gets
 *     no new crawl_jobs row.
 *  2. The ETag-based "is the homepage unchanged" decision — its actual
 *     comparison logic (isHomepageUnchanged) is unit-tested directly,
 *     rather than over a real HTTP round-trip, because the fetch it
 *     feeds runs through the same SSRF pre-flight as the main crawl
 *     (crawl-safety.ts), which correctly refuses to fetch a loopback
 *     test server with no allowlist override — exactly like a real
 *     deployment never gets one. The third test below proves that same
 *     refusal FAILS SAFE: a conditional check that can't run (blocked,
 *     unreachable, whatever) falls through to a real crawl rather than
 *     silently skipping forever.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "@/db";
import { organizations } from "@/db/auth-schema";
import { websites, crawlJobs } from "@/db/app-schema";
import { handleScheduledAuditTrigger, isHomepageUnchanged } from "./scheduled-audit";

describe("isHomepageUnchanged (pure)", () => {
  it("treats a literal 304 as unchanged, regardless of ETag", () => {
    expect(isHomepageUnchanged(304, undefined, '"anything"')).toBe(true);
    expect(isHomepageUnchanged(304, '"whatever"', null)).toBe(true);
  });

  it("treats a matching, non-empty stored ETag as unchanged", () => {
    expect(isHomepageUnchanged(200, '"abc"', '"abc"')).toBe(true);
  });

  it("treats a different ETag as changed", () => {
    expect(isHomepageUnchanged(200, '"abc"', '"xyz"')).toBe(false);
  });

  it("treats no stored ETag as changed (nothing to compare against)", () => {
    expect(isHomepageUnchanged(200, '"abc"', null)).toBe(false);
    expect(isHomepageUnchanged(200, '"abc"', undefined)).toBe(false);
  });
});

describe("scheduled-audit guards against unnecessary re-crawling (real Postgres)", () => {
  let orgId: string;

  beforeAll(async () => {
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    orgId = `test-org-stale-${uniq}`;
    await db.insert(organizations).values({ id: orgId, name: "Staleness Test Org", slug: `test-org-stale-${uniq}`, createdAt: new Date() });
  }, 20_000);

  afterAll(async () => {
    await pool.query(`DELETE FROM pgboss.job WHERE name = 'crawl-website' AND data->>'websiteId' IN (SELECT id::text FROM websites WHERE organization_id = $1)`, [orgId]).catch(() => {});
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await pool.end();
  });

  afterEach(() => {
    delete process.env.SCHEDULED_CRAWL_MIN_INTERVAL_MS;
  });

  it("skips (no new crawl_jobs row) when the minimum interval since the last scheduled crawl hasn't elapsed", async () => {
    process.env.SCHEDULED_CRAWL_MIN_INTERVAL_MS = String(60 * 60 * 1000); // 1 hour floor
    const [website] = await db
      .insert(websites)
      .values({
        organizationId: orgId,
        url: "http://127.0.0.1:1/",
        verificationToken: "t",
        auditSchedule: "daily",
        lastScheduledCrawlAt: new Date(), // "just crawled"
      })
      .returning();

    await handleScheduledAuditTrigger({ websiteId: website.id });

    const jobs = await db.select().from(crawlJobs).where(eq(crawlJobs.websiteId, website.id));
    expect(jobs).toHaveLength(0);
  });

  it("fails safe: when the conditional check itself can't run (blocked target), it still crawls rather than skipping forever", async () => {
    // No allowlist override reaches this code path (same as production:
    // handleScheduledAuditTrigger never receives one), so the loopback
    // conditional GET is correctly refused by the SSRF pre-flight. The
    // guard must not mistake "couldn't check" for "unchanged".
    const [website] = await db
      .insert(websites)
      .values({
        organizationId: orgId,
        url: "http://127.0.0.1:1/",
        verificationToken: "t",
        auditSchedule: "daily",
        lastHomepageEtag: '"whatever-is-cached"',
      })
      .returning();

    await handleScheduledAuditTrigger({ websiteId: website.id });

    const jobs = await db.select().from(crawlJobs).where(eq(crawlJobs.websiteId, website.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].trigger).toBe("scheduled");
  });
});
