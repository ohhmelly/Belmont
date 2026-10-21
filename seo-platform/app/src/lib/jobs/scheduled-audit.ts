/**
 * pg-boss job handler for `scheduled-audit-trigger` (Phase 5).
 *
 * This is the job pg-boss's own cron scheduler (`boss.schedule()`, see
 * src/lib/queue.ts#applyWebsiteSchedule) actually fires. It is
 * deliberately NOT the same job type as a manual crawl (`crawl-website`,
 * src/lib/jobs/crawl-website.ts, which this file never modifies): a
 * schedule tick always carries the same fixed payload (just `websiteId`),
 * so something has to decide, fresh each time, whether a crawl is even
 * warranted and create a brand-new `crawl_jobs` row for it — that
 * decision lives here, not in the crawl handler itself.
 *
 * Two cheap guards run before a full multi-page crawl is ever kicked off
 * (spec section 7 — "avoid unnecessary re-crawling of unchanged
 * content"), deliberately modest rather than a full incremental-crawl
 * system:
 *
 *  1. Minimum interval: regardless of how aggressive the configured
 *     cadence is, a website is never scheduled-crawled more than once per
 *     `SCHEDULED_CRAWL_MIN_INTERVAL_MS` (default 6h). This is the floor
 *     that matters most in practice — a misconfigured or very short cron
 *     can never hammer a site.
 *  2. Conditional homepage fetch: if the site's last scheduled crawl
 *     recorded an ETag or Last-Modified for the homepage, this does one
 *     cheap GET with `If-None-Match`/`If-Modified-Since` first. A 304 (or
 *     an identical ETag) means the homepage is byte-for-byte unchanged
 *     since last time, which is a reasonable, cheap signal that the rest
 *     of the site likely hasn't changed either — good enough to skip a
 *     full crawl this cycle, NOT a guarantee (a change on an inner page
 *     with a static homepage would be missed). A full incremental,
 *     page-by-page change-detection crawl is a materially larger feature
 *     and is left as a documented future improvement rather than
 *     attempted here. A site with no ETag/Last-Modified at all (common)
 *     just falls back to guard #1 alone.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { websites, crawlJobs } from "@/db/app-schema";
import { enqueueCrawl } from "@/lib/queue";
import { safeFetch, CrawlSafetyError } from "@/lib/crawl-safety";
import type { ScheduledAuditTriggerData } from "@/lib/queue";

function log(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: "scheduled-audit", event, ...data }));
}

/**
 * The actual "is the homepage unchanged" decision, pulled out as a pure
 * function so it has a unit test that doesn't need a network call: a
 * literal 304, or a non-empty stored ETag that matches the response's.
 */
export function isHomepageUnchanged(
  status: number,
  responseEtag: string | undefined,
  storedEtag: string | null | undefined
): boolean {
  return status === 304 || (Boolean(storedEtag) && responseEtag === storedEtag);
}

export async function handleScheduledAuditTrigger(data: ScheduledAuditTriggerData): Promise<void> {
  const { websiteId } = data;
  const [website] = await db.select().from(websites).where(eq(websites.id, websiteId));
  if (!website) {
    log("skipped", { websiteId, reason: "website_not_found" });
    return;
  }
  if (website.auditSchedule === "none") {
    // The website's own schedule was disabled after this tick was already
    // queued (schedule() changes take effect from the next tick onward);
    // honor the disable rather than crawl anyway.
    log("skipped", { websiteId, reason: "schedule_disabled" });
    return;
  }

  // --- Guard 1: minimum interval between scheduled crawls ---
  const minIntervalMs = Number(process.env.SCHEDULED_CRAWL_MIN_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
  if (website.lastScheduledCrawlAt) {
    const elapsedMs = Date.now() - website.lastScheduledCrawlAt.getTime();
    if (elapsedMs < minIntervalMs) {
      log("skipped", {
        websiteId,
        reason: "min_interval_not_elapsed",
        elapsedMs,
        minIntervalMs,
      });
      return;
    }
  }

  // --- Guard 2: cheap conditional-GET staleness check on the homepage ---
  let newEtag = website.lastHomepageEtag ?? null;
  let newLastModified = website.lastHomepageLastModified ?? null;
  if (website.lastHomepageEtag || website.lastHomepageLastModified) {
    try {
      const headers: Record<string, string> = {};
      if (website.lastHomepageEtag) headers["If-None-Match"] = website.lastHomepageEtag;
      if (website.lastHomepageLastModified) headers["If-Modified-Since"] = website.lastHomepageLastModified;

      const res = await safeFetch(website.url, { method: "GET", headers, timeoutMs: 10_000 });
      newEtag = (res.headers.etag as string | undefined) ?? newEtag;
      newLastModified = (res.headers["last-modified"] as string | undefined) ?? newLastModified;

      if (isHomepageUnchanged(res.status, res.headers.etag, website.lastHomepageEtag)) {
        await db
          .update(websites)
          .set({ lastScheduledCrawlAt: new Date(), lastHomepageEtag: newEtag, lastHomepageLastModified: newLastModified })
          .where(eq(websites.id, websiteId));
        log("skipped", { websiteId, reason: "homepage_unchanged", status: res.status });
        return;
      }
    } catch (err) {
      // A failed conditional check is not a reason to skip the crawl —
      // fall through and crawl normally; the real crawl's own SSRF
      // pre-flight will catch anything genuinely unsafe.
      const message = err instanceof CrawlSafetyError ? err.message : String(err);
      log("conditional_check_failed", { websiteId, error: message });
    }
  }

  // --- Create the crawl_jobs row and enqueue the real crawl-website job ---
  const [job] = await db
    .insert(crawlJobs)
    .values({ websiteId, status: "pending", trigger: "scheduled" })
    .returning();

  const pgBossJobId = await enqueueCrawl({ crawlJobId: job.id, websiteId, url: website.url });
  if (pgBossJobId) {
    await db.update(crawlJobs).set({ pgBossJobId }).where(eq(crawlJobs.id, job.id));
  }

  await db
    .update(websites)
    .set({ lastScheduledCrawlAt: new Date(), lastHomepageEtag: newEtag, lastHomepageLastModified: newLastModified })
    .where(eq(websites.id, websiteId));

  log("enqueued", { websiteId, crawlJobId: job.id, pgBossJobId });
}
