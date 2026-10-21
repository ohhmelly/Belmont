/**
 * pg-boss job handler for `crawl-website`. Runs the full Phase 3
 * pipeline: crawl-safety pre-flight (inside the adapter) -> siteone-crawler
 * subprocess -> normalized findings -> supplementary rule-engine pass ->
 * persisted `findings` rows, with the `crawl_jobs` row's lifecycle
 * (pending -> running -> completed/failed) updated throughout.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { crawlJobs, findings } from "@/db/app-schema";
import { runCrawl, type CrawlOptions } from "@/lib/crawler-adapter";
import type { CrawlWebsiteJobData } from "@/lib/queue";

export async function handleCrawlWebsiteJob(data: CrawlWebsiteJobData): Promise<void> {
  const { crawlJobId, websiteId, url, options } = data;

  await db
    .update(crawlJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(crawlJobs.id, crawlJobId));

  try {
    const crawlOptions: CrawlOptions = {
      maxPages: options?.maxPages,
      maxDepth: options?.maxDepth,
      jsRendering: options?.jsRendering,
      allowlistOrigins: options?.allowlistOrigins,
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
      .where(eq(crawlJobs.id, crawlJobId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(crawlJobs)
      .set({ status: "failed", finishedAt: new Date(), error: message })
      .where(eq(crawlJobs.id, crawlJobId));
    throw err; // let pg-boss record the job attempt as failed too
  }
}
