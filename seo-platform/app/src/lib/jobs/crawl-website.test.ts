/**
 * End-to-end pipeline test: real fixture server + real siteone-crawler
 * subprocess + real Postgres. Creates a real organization/website/
 * crawl_jobs row, runs the actual job handler (same code path the
 * worker uses), and asserts on the actual `findings` rows written to
 * the database — not a mock of the DB layer.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "@/db";
import { organizations } from "@/db/auth-schema";
import { websites, crawlJobs, findings } from "@/db/app-schema";
import { handleCrawlWebsiteJob } from "./crawl-website";
import { startFixtureServer, type FixtureServerHandle } from "../test-support/fixture-server";

describe("crawl-website job (real Postgres + real crawl)", () => {
  let server: FixtureServerHandle;
  let orgId: string;
  let websiteId: string;
  let crawlJobId: string;

  beforeAll(async () => {
    server = await startFixtureServer(4211, { FIXTURE_SLOW_DELAY_MS: "6000" });

    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    orgId = `test-org-${uniq}`;
    await db.insert(organizations).values({
      id: orgId,
      name: "Test Org",
      slug: `test-org-${uniq}`,
      createdAt: new Date(),
    });

    const [website] = await db
      .insert(websites)
      .values({
        organizationId: orgId,
        url: `${server.origin}/`,
        verificationToken: "test-token",
      })
      .returning();
    websiteId = website.id;

    const [job] = await db
      .insert(crawlJobs)
      .values({ websiteId, status: "pending" })
      .returning();
    crawlJobId = job.id;
  }, 20_000);

  afterAll(async () => {
    await server.stop();
    // crawl_jobs/findings cascade-delete when the org is deleted (FKs are ON DELETE CASCADE).
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await pool.end();
  });

  it("runs the full pipeline and writes real findings rows to Postgres", async () => {
    await handleCrawlWebsiteJob({
      crawlJobId,
      websiteId,
      url: `${server.origin}/`,
      options: { allowlistOrigins: [server.origin] },
    });

    const [job] = await db.select().from(crawlJobs).where(eq(crawlJobs.id, crawlJobId));
    expect(job.status).toBe("completed");
    expect(job.finishedAt).toBeTruthy();

    const rows = await db.select().from(findings).where(eq(findings.crawlJobId, crawlJobId));
    expect(rows.length).toBeGreaterThan(5);

    // Every row carries the full normalized schema.
    for (const row of rows) {
      expect(row.websiteId).toBe(websiteId);
      expect(row.crawlJobId).toBe(crawlJobId);
      expect(["siteone-crawler", "supplementary-rules", "crawler-adapter"]).toContain(row.sourceEngine);
      expect(["critical", "high", "medium", "low"]).toContain(row.severity);
      expect(row.discoveredAt).toBeTruthy();
    }

    const categories = new Set(rows.map((r) => r.category));
    expect(categories.has("missing_title")).toBe(true);
    expect(categories.has("broken_link")).toBe(true);
    expect(categories.has("server_error")).toBe(true);
    expect(categories.has("redirect_chain")).toBe(true);
    expect(categories.has("redirect_loop")).toBe(true);
    expect(categories.has("ssrf_blocked_redirect")).toBe(true);
    expect(categories.has("canonical_conflict")).toBe(true);

    // The SSRF-blocked redirect must never show up as a page the crawl actually reached.
    const touchedPrivateTarget = rows.some((r) => r.url.includes("169.254.169.254"));
    expect(touchedPrivateTarget).toBe(false);

    // Robots-disallowed page must not appear as a findings subject at all.
    const privatePageFindings = rows.filter((r) => r.url.includes("/private/secret"));
    expect(privatePageFindings).toHaveLength(0);
  }, 60_000);
});
