/**
 * Real proof of the notifier (spec section 6): writes a real
 * `notifications` row to real Postgres when a diff has at least one NEW
 * finding of medium severity or higher, stays silent (no row) when it
 * doesn't, and proves the optional SMTP email leg genuinely no-ops
 * (never throws, never blocks) when `SMTP_URL` isn't set — which is the
 * only configuration this sandbox can verify without real SMTP
 * credentials. The email-send-success path itself is implemented but not
 * live-verified here; see the completion report for why.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "@/db";
import { organizations, members, users } from "@/db/auth-schema";
import { websites, notifications, crawlJobs } from "@/db/app-schema";
import { notifyIfMeaningful } from "./notifier";
import type { FindingRow } from "@/lib/findings-diff";

function makeFinding(overrides: Partial<FindingRow>): FindingRow {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    crawlJobId: overrides.crawlJobId ?? "job-1",
    websiteId: overrides.websiteId ?? "site-1",
    sourceEngine: "siteone-crawler",
    url: overrides.url ?? "https://example.com/",
    canonicalUrl: null,
    httpStatus: null,
    severity: overrides.severity ?? "high",
    category: overrides.category ?? "broken_link",
    title: overrides.title ?? "A finding",
    description: "",
    evidence: {},
    discoveredAt: new Date(),
  };
}

describe("notifyIfMeaningful (real Postgres)", () => {
  let orgId: string;
  let userId: string;
  let websiteId: string;

  beforeAll(async () => {
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    orgId = `test-org-notify-${uniq}`;
    userId = `test-user-notify-${uniq}`;

    await db.insert(organizations).values({ id: orgId, name: "Notify Test Org", slug: `test-org-notify-${uniq}`, createdAt: new Date() });
    await db.insert(users).values({ id: userId, name: "Notify Test User", email: `notify-${uniq}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(members).values({ id: `member-${uniq}`, organizationId: orgId, userId, role: "owner", createdAt: new Date() });

    const [website] = await db
      .insert(websites)
      .values({ organizationId: orgId, url: "https://example.test/", verificationToken: "t" })
      .returning();
    websiteId = website.id;
  }, 20_000);

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(eq(users.id, userId));
    await pool.end();
  });

  it("writes a real notifications row and no-ops the unconfigured SMTP email when a NEW finding is high severity", async () => {
    expect(process.env.SMTP_URL).toBeUndefined();

    const [job] = await db.insert(crawlJobs).values({ websiteId, status: "completed", trigger: "scheduled" }).returning();
    const crawlJobId = job.id;
    const diff = {
      newFindings: [makeFinding({ severity: "high", category: "broken_link", url: "https://example.test/new", title: "New broken link" })],
      resolvedFindings: [],
      persistingFindings: [],
      previousCrawlJobId: "prev-job",
      currentCrawlJobId: crawlJobId,
    };

    const result = await notifyIfMeaningful({
      organizationId: orgId,
      websiteId,
      websiteUrl: "https://example.test/",
      crawlJobId,
      diff,
    });

    expect(result.notified).toBe(true);
    expect(result.notificationId).toBeTruthy();
    // SMTP_URL is unset in this sandbox — no-op, not an error, not a block.
    expect(result.email.sent).toBe(false);
    expect(result.email.reason).toBe("smtp_not_configured");

    const [row] = await db.select().from(notifications).where(eq(notifications.id, result.notificationId!));
    expect(row).toBeTruthy();
    expect(row.organizationId).toBe(orgId);
    expect(row.websiteId).toBe(websiteId);
    expect(row.type).toBe("new_findings");
    expect(row.severity).toBe("high");
    expect(row.isRead).toBe(false);
    expect(row.body).toContain("New broken link");
  });

  it("does not notify (and writes no row) when the only NEW findings are low severity", async () => {
    const [job] = await db.insert(crawlJobs).values({ websiteId, status: "completed", trigger: "scheduled" }).returning();
    const crawlJobId = job.id;
    const diff = {
      newFindings: [makeFinding({ severity: "low", category: "missing_meta_description", url: "https://example.test/minor" })],
      resolvedFindings: [],
      persistingFindings: [],
      previousCrawlJobId: "prev-job-2",
      currentCrawlJobId: crawlJobId,
    };

    const result = await notifyIfMeaningful({
      organizationId: orgId,
      websiteId,
      websiteUrl: "https://example.test/",
      crawlJobId,
      diff,
    });

    expect(result.notified).toBe(false);
    expect(result.reason).toBe("no_meaningful_new_findings");

    const rows = await db.select().from(notifications).where(eq(notifications.crawlJobId, crawlJobId));
    expect(rows).toHaveLength(0);
  });
});
