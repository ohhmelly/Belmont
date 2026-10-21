/**
 * pg-boss job handler for `crawl-website`. Runs the full Phase 3
 * pipeline: crawl-safety pre-flight (inside the adapter) -> siteone-crawler
 * subprocess -> normalized findings -> supplementary rule-engine pass ->
 * persisted `findings` rows, with the `crawl_jobs` row's lifecycle
 * (pending -> running -> completed/failed) updated throughout.
 */
import { eq, and, ne } from "drizzle-orm";
import { db } from "@/db";
import { crawlJobs, findings } from "@/db/app-schema";
import { runCrawl, type CrawlOptions } from "@/lib/crawler-adapter";
import type { CrawlWebsiteJobData } from "@/lib/queue";

/**
 * Phase 5 addition: `signal` is the pg-boss job's own `job.signal` (passed
 * through by worker.ts, optional so existing callers/tests are
 * unaffected). It's threaded into the crawler subprocess so a real
 * cancellation actually kills the running crawl instead of letting it run
 * to completion in the background.
 *
 * Every DB write below that marks a terminal status (`completed`/
 * `failed`) is guarded with `status != 'cancelled'` so a cancellation
 * that lands while this handler is mid-run can never be clobbered by a
 * late write from the very attempt it cancelled.
 */
export async function handleCrawlWebsiteJob(
  data: CrawlWebsiteJobData,
  signal?: AbortSignal
): Promise<void> {
  const { crawlJobId, websiteId, url, options } = data;

  await db
    .update(crawlJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(crawlJobs.id, crawlJobId), ne(crawlJobs.status, "cancelled")));

  try {
    const crawlOptions: CrawlOptions = {
      maxPages: options?.maxPages,
      maxDepth: options?.maxDepth,
      jsRendering: options?.jsRendering,
      allowlistOrigins: options?.allowlistOrigins,
      signal,
    };

    const result = await runCrawl(url, crawlOptions);

    if (result.findings.length > 0) {
      await db.insert(findings).values(
        result.findings.map((f) => ({
          crawlJobId,
          websiteId,
          sourceEngine: f.sourceEngine,
          url: f.url,
          canonicalUrl: f.canonicalUrl ?? null,
          httpStatus: f.httpStatus ?? null,
          severity: f.severity,
          category: f.category,
          title: f.title,
          description: f.description,
          evidence: f.evidence,
        }))
      );
    }

    await db
      .update(crawlJobs)
      .set({
        status: "completed",
        finishedAt: new Date(),
        options: { ...(options ?? {}), resultMeta: result.meta },
      })
      .where(and(eq(crawlJobs.id, crawlJobId), ne(crawlJobs.status, "cancelled")));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(crawlJobs)
      .set({ status: "failed", finishedAt: new Date(), error: message })
      .where(and(eq(crawlJobs.id, crawlJobId), ne(crawlJobs.status, "cancelled")));
    throw err; // let pg-boss record the job attempt as failed too
  }
}
