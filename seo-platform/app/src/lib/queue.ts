/**
 * Shared pg-boss accessor for the Next.js app side (enqueueing jobs from
 * a server action/route handler). The worker process (src/worker.ts)
 * manages its own PgBoss instance for actually processing jobs — this
 * one is only ever used to `.send()` / `.schedule()` / `.cancel()` work
 * into the same Postgres-backed queue, never to `.work()` it.
 *
 * Phase 5 retry/expiry policy (see docs/ARCHITECTURE.md and the completion
 * report for the empirical proof): a transient failure (e.g. the target
 * site being briefly unreachable) is retried automatically by pg-boss
 * rather than failing permanently on the first error, and a job that never
 * reports back within `expireInSeconds` (worker crash, SIGKILL, etc.) is
 * retried/failed by pg-boss's own monitor — this is what makes jobs
 * survive an application restart without any bespoke "stuck job" sweep.
 */
import { PgBoss } from "pg-boss";
import type { SendOptions } from "pg-boss";

export const CRAWL_WEBSITE_QUEUE = "crawl-website";
export const SCHEDULED_AUDIT_QUEUE = "scheduled-audit-trigger";

/**
 * Queue-level defaults for `crawl-website`. Every job on this queue
 * inherits these unless a `send()`/`schedule()` call overrides them
 * per-job (used by the retry/expiry proof test).
 *
 *  - retryLimit/retryDelay/retryBackoff: up to 3 retries, exponential
 *    backoff starting at 5s, so a brief network blip or target-site
 *    hiccup recovers on its own instead of failing the whole crawl.
 *  - expireInSeconds: how long a job may sit "active" with no heartbeat
 *    before pg-boss itself declares the attempt dead and retries/fails
 *    it. This is the mechanism that recovers a crawl whose worker
 *    process was SIGKILLed mid-job — see the restart-recovery proof.
 *    900s (15 min) comfortably covers a real multi-page crawl
 *    (siteone-crawler's own --timeout/--max-visited-urls bound it) while
 *    still being far short of "stuck forever".
 */
export const CRAWL_WEBSITE_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 5,
  retryBackoff: true,
  expireInSeconds: 900,
} as const;

let bossPromise: Promise<PgBoss> | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    bossPromise = (async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error("DATABASE_URL is not set.");
      }
      // `schedule: false` — the worker process (src/worker.ts) is the one
      // long-running instance responsible for firing cron schedules; this
      // app-side instance only reads/writes schedule rows (`schedule()`,
      // `unschedule()`), so it doesn't also need to run the cron-checking
      // timekeeper.
      const boss = new PgBoss({ connectionString, schedule: false });
      boss.on("error", (err) => console.error("[queue] pg-boss error:", err));
      await boss.start();
      await boss.createQueue(CRAWL_WEBSITE_QUEUE, CRAWL_WEBSITE_QUEUE_OPTIONS);
      await boss.createQueue(SCHEDULED_AUDIT_QUEUE, { retryLimit: 1 });
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

/** Data for the lightweight job a schedule fires; it decides whether to actually kick off a crawl (see scheduled-audit.ts) and, if so, creates the crawl_jobs row and enqueues onto CRAWL_WEBSITE_QUEUE itself. */
export interface ScheduledAuditTriggerData {
  websiteId: string;
}

export async function enqueueCrawl(
  data: CrawlWebsiteJobData,
  sendOptions?: SendOptions
): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(CRAWL_WEBSITE_QUEUE, data, sendOptions);
}

/** none | daily | weekly | monthly. "none" clears any existing schedule. */
export type AuditScheduleCadence = "none" | "daily" | "weekly" | "monthly";

/**
 * Real production cron expressions for each cadence (UTC). Documented here
 * rather than only in the UI, per the spec's request to show "what a real
 * daily/weekly/monthly cron expression looks like":
 *   daily   -> "0 3 * * *"      every day at 03:00 UTC
 *   weekly  -> "0 3 * * 1"      every Monday at 03:00 UTC
 *   monthly -> "0 3 1 * *"      the 1st of every month at 03:00 UTC
 */
export const CADENCE_CRON: Record<Exclude<AuditScheduleCadence, "none">, string> = {
  daily: "0 3 * * *",
  weekly: "0 3 * * 1",
  monthly: "0 3 1 * *",
};

/**
 * Create/replace/remove this website's recurring audit schedule using
 * pg-boss's own `schedule()` (cron-based), keyed by the website's id so a
 * second call for the same site replaces the first rather than stacking
 * schedules. `cronOverride` exists only so tests can prove a schedule
 * actually fires without waiting a full day — production callers never
 * pass it.
 */
export async function applyWebsiteSchedule(
  websiteId: string,
  cadence: AuditScheduleCadence,
  cronOverride?: string
): Promise<void> {
  const boss = await getBoss();
  if (cadence === "none") {
    await boss.unschedule(SCHEDULED_AUDIT_QUEUE, websiteId);
    return;
  }
  const cron = cronOverride ?? CADENCE_CRON[cadence];
  await boss.schedule(
    SCHEDULED_AUDIT_QUEUE,
    cron,
    { websiteId } satisfies ScheduledAuditTriggerData,
    { key: websiteId, tz: "UTC" }
  );
}

/**
 * Cancel a crawl job that is still queued or actively running. Tells
 * pg-boss to cancel the underlying job (which, for an active job, aborts
 * its `job.signal` — see crawl-website.ts) and returns whether pg-boss had
 * a job to cancel at all. The caller is still responsible for updating the
 * `crawl_jobs` row's status.
 */
export async function cancelCrawlJob(pgBossJobId: string): Promise<void> {
  const boss = await getBoss();
  await boss.cancel(CRAWL_WEBSITE_QUEUE, pgBossJobId);
}
