/**
 * Background job worker — same codebase as the Next.js app, different
 * entrypoint (per ARCHITECTURE.md). Docker Compose's `worker` service runs
 * this file instead of `next start`.
 *
 * Phase 2 built the pg-boss (our Postgres-native job queue, chosen over
 * Redis/BullMQ so a single-server self-hosted deployment needs no extra
 * infra) foundation: it starts against Postgres, stays up, and reports
 * healthy, with no job handlers registered.
 *
 * Phase 3 registers the first real job type: `crawl-website` (see
 * src/lib/jobs/crawl-website.ts and docs/INTEGRATION_ARCHITECTURE.md).
 *
 * Phase 5 adds:
 *  - the `scheduled-audit-trigger` queue/handler (recurring audits —
 *    src/lib/jobs/scheduled-audit.ts), fired by pg-boss's own cron
 *    scheduler rather than a hand-rolled loop.
 *  - retry/expiry policy on `crawl-website` (CRAWL_WEBSITE_QUEUE_OPTIONS
 *    in src/lib/queue.ts) so a transient failure retries, and a worker
 *    that dies mid-job (SIGKILL) leaves its job recoverable by pg-boss's
 *    own expiry monitor instead of stuck "running" forever.
 *  - `WORKER_CONCURRENCY` (default 2): how many `crawl-website` jobs this
 *    worker process runs at once (pg-boss `localConcurrency`). Each is
 *    still a real siteone-crawler subprocess, so keep this modest on a
 *    small box.
 *  - structured (JSON-lines) logging of job lifecycle events: enqueued
 *    (logged where the job is created — actions.ts / scheduled-audit.ts),
 *    started, retrying, completed, failed, cancelled.
 *  - after a *scheduled* crawl completes, computes the before/after
 *    findings diff and fires the notifier (src/lib/notifications/notifier.ts)
 *    when it finds meaningfully new issues. A manual crawl never does
 *    this — only scheduled/automated monitoring pages a human.
 */
import "dotenv/config";
import http from "node:http";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { db } from "./db";
import { websites, crawlJobs } from "./db/app-schema";
import {
  CRAWL_WEBSITE_QUEUE,
  CRAWL_WEBSITE_QUEUE_OPTIONS,
  SCHEDULED_AUDIT_QUEUE,
} from "./lib/queue";
import { handleCrawlWebsiteJob } from "./lib/jobs/crawl-website";
import { handleScheduledAuditTrigger } from "./lib/jobs/scheduled-audit";
import { computeCrawlDiff } from "./lib/findings-diff";
import { notifyIfMeaningful } from "./lib/notifications/notifier";
import type { CrawlWebsiteJobData, ScheduledAuditTriggerData } from "./lib/queue";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and configure it."
  );
}

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 3001);

/**
 * How many `crawl-website` jobs this worker process runs at once
 * (pg-boss's per-queue `localConcurrency`). Default 2: each crawl is a
 * real subprocess plus supplementary HTTP fetches, so this is deliberately
 * conservative for a single small box; raise it on a bigger worker host.
 */
const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);

let boss: PgBoss | null = null;
let ready = false;

/** Structured (JSON-lines) logging for job lifecycle events — simple and real, not elaborate. */
function logEvent(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: "worker", event, ...data }));
}

/**
 * After a crawl-website job's handler returns without throwing, re-read
 * its crawl_jobs row (the handler already settled it to completed/failed/
 * left it cancelled) and, only for a completed *scheduled* crawl, compute
 * the before/after diff and run it past the notifier. Never throws —
 * a notification problem must never be mistaken for a crawl failure by
 * pg-boss.
 */
async function maybeNotifyAfterCrawl(crawlJobId: string): Promise<void> {
  try {
    const [job] = await db.select().from(crawlJobs).where(eq(crawlJobs.id, crawlJobId));
    if (!job || job.status !== "completed" || job.trigger !== "scheduled") return;

    const [website] = await db.select().from(websites).where(eq(websites.id, job.websiteId));
    if (!website) return;

    const diff = await computeCrawlDiff(job.websiteId);
    if (!diff) {
      logEvent("notify_skipped", { crawlJobId, reason: "fewer_than_two_completed_crawls" });
      return;
    }

    const result = await notifyIfMeaningful({
      organizationId: website.organizationId,
      websiteId: website.id,
      websiteUrl: website.url,
      crawlJobId,
      diff,
    });
    logEvent("notify_result", { crawlJobId, ...result });
  } catch (err) {
    logEvent("notify_error", { crawlJobId, error: err instanceof Error ? err.message : String(err) });
  }
}

async function main() {
  boss = new PgBoss({ connectionString });

  boss.on("error", (err) => {
    console.error("[worker] pg-boss error:", err);
  });

  await boss.start();
  await boss.createQueue(CRAWL_WEBSITE_QUEUE, CRAWL_WEBSITE_QUEUE_OPTIONS);
  await boss.createQueue(SCHEDULED_AUDIT_QUEUE, { retryLimit: 1 });

  await boss.work<CrawlWebsiteJobData>(
    CRAWL_WEBSITE_QUEUE,
    { localConcurrency: WORKER_CONCURRENCY },
    async ([job]) => {
      const { crawlJobId, websiteId } = job.data;
      if (job.retryCount > 0) {
        logEvent("retrying", { jobId: job.id, crawlJobId, websiteId, attempt: job.retryCount });
      }
      logEvent("started", { jobId: job.id, crawlJobId, websiteId, attempt: job.retryCount });
      try {
        await handleCrawlWebsiteJob(job.data, job.signal);
        const [row] = await db.select().from(crawlJobs).where(eq(crawlJobs.id, crawlJobId));
        if (row?.status === "cancelled") {
          logEvent("cancelled", { jobId: job.id, crawlJobId, websiteId });
        } else {
          logEvent("completed", { jobId: job.id, crawlJobId, websiteId });
        }
        await maybeNotifyAfterCrawl(crawlJobId);
      } catch (err) {
        logEvent("failed", {
          jobId: job.id,
          crawlJobId,
          websiteId,
          attempt: job.retryCount,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err; // pg-boss decides retry vs. terminal failure from retryCount/retryLimit
      }
    }
  );

  await boss.work<ScheduledAuditTriggerData>(SCHEDULED_AUDIT_QUEUE, async ([job]) => {
    logEvent("scheduled_trigger_started", { jobId: job.id, websiteId: job.data.websiteId });
    await handleScheduledAuditTrigger(job.data);
  });

  ready = true;
  console.log("[worker] pg-boss started and connected to Postgres.");
  console.log(`[worker] listening for "${CRAWL_WEBSITE_QUEUE}" jobs (concurrency=${WORKER_CONCURRENCY}).`);
  console.log(`[worker] listening for "${SCHEDULED_AUDIT_QUEUE}" jobs.`);
}

// A tiny, honest health endpoint: 200 only once pg-boss has actually
// started against Postgres, 503 otherwise. Used by the Docker Compose
// healthcheck for this service.
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: ready ? "ok" : "starting" }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(HEALTH_PORT, () => {
  console.log(`[worker] health endpoint listening on :${HEALTH_PORT}/healthz`);
});

async function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, shutting down...`);
  server.close();
  if (boss) {
    await boss.stop();
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  console.error("[worker] failed to start:", err);
  process.exit(1);
});
