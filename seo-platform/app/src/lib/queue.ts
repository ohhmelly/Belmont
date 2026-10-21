/**
 * Shared pg-boss accessor for the Next.js app side (enqueueing jobs from
 * a server action/route handler). The worker process (src/worker.ts)
 * manages its own PgBoss instance for actually processing jobs — this
 * one is only ever used to `.send()` work into the same Postgres-backed
 * queue, never to `.work()` it.
 */
import { PgBoss } from "pg-boss";

export const CRAWL_WEBSITE_QUEUE = "crawl-website";

let bossPromise: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    bossPromise = (async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error("DATABASE_URL is not set.");
      }
      const boss = new PgBoss({ connectionString });
      boss.on("error", (err) => console.error("[queue] pg-boss error:", err));
      await boss.start();
      await boss.createQueue(CRAWL_WEBSITE_QUEUE);
      return boss;
    })();
  }
  return bossPromise;
}

export interface CrawlWebsiteJobData {
  crawlJobId: string;
  websiteId: string;
  url: string;
  options?: {
    maxPages?: number;
    maxDepth?: number;
    jsRendering?: boolean;
    allowlistOrigins?: string[];
  };
}

export async function enqueueCrawl(data: CrawlWebsiteJobData): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(CRAWL_WEBSITE_QUEUE, data);
}
