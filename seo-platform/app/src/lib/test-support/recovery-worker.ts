/**
 * Standalone worker entrypoint used ONLY by the restart-recovery proof
 * (src/worker-restart-recovery.test.ts). Spawned as a real child process
 * (same pattern as fixture-server.ts) so the test can SIGKILL it exactly
 * like a real worker crash and observe pg-boss's own recovery behavior —
 * this is deliberately a separate, parameterized entrypoint rather than
 * reusing src/worker.ts directly, so the test can dial `expireInSeconds`/
 * `superviseIntervalSeconds` down to a few seconds (production uses
 * CRAWL_WEBSITE_QUEUE_OPTIONS's real 900s/60s) without changing
 * production defaults, and so it never collides with the real
 * `crawl-website` queue's configuration.
 *
 * Logs one JSON line per lifecycle event to stdout, which the test reads
 * back as real evidence.
 */
import "dotenv/config";
import { PgBoss } from "pg-boss";
import { handleCrawlWebsiteJob } from "@/lib/jobs/crawl-website";
import type { CrawlWebsiteJobData } from "@/lib/queue";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set.");

const queueName = process.env.RECOVERY_WORKER_QUEUE ?? "crawl-website-restart-proof";
const expireInSeconds = Number(process.env.RECOVERY_WORKER_EXPIRE_SECONDS ?? 5);
const retryLimit = Number(process.env.RECOVERY_WORKER_RETRY_LIMIT ?? 1);
const superviseIntervalSeconds = Number(process.env.RECOVERY_WORKER_SUPERVISE_INTERVAL ?? 1);
// pg-boss caches its queue list (used by the supervise pass to know which
// queues to check for expiry) and only refreshes it every
// `queueCacheIntervalSeconds` (default 60s) — far too slow for this proof's
// short expiry window, so it's dialed down right alongside the supervise
// interval.
const queueCacheIntervalSeconds = Number(process.env.RECOVERY_WORKER_QUEUE_CACHE_INTERVAL ?? superviseIntervalSeconds);
// The supervise pass itself runs every `superviseIntervalSeconds`, but
// within each pass it only actually checks (and expires) a given queue
// when THAT queue's own monitor claim is due — gated by
// `monitorIntervalSeconds` (also default 60s). Both have to be dialed
// down together for expiry to actually happen quickly.
const monitorIntervalSeconds = Number(process.env.RECOVERY_WORKER_MONITOR_INTERVAL ?? superviseIntervalSeconds);

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, pid: process.pid, ...data }));
}

async function main() {
  const boss = new PgBoss({
    connectionString,
    schedule: false,
    superviseIntervalSeconds,
    queueCacheIntervalSeconds,
    monitorIntervalSeconds,
  });
  boss.on("error", (err) => log("boss_error", { error: String(err) }));
  await boss.start();
  await boss.createQueue(queueName, { expireInSeconds, retryLimit, retryDelay: 1 });
  log("ready", { queueName, expireInSeconds, retryLimit, superviseIntervalSeconds, queueCacheIntervalSeconds, monitorIntervalSeconds });

  await boss.work<CrawlWebsiteJobData>(queueName, async ([job]) => {
    log("job_started", { jobId: job.id, retryCount: job.retryCount, crawlJobId: job.data.crawlJobId });
    await handleCrawlWebsiteJob(job.data, job.signal);
    log("job_finished", { jobId: job.id, retryCount: job.retryCount, crawlJobId: job.data.crawlJobId });
  });
}

main().catch((err) => {
  log("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
