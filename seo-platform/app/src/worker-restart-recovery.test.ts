/**
 * Phase 5 hard requirement: "Jobs must survive application restarts
 * where applicable." This test proves it empirically rather than by
 * assertion alone:
 *
 *   1. A real worker process (src/lib/test-support/recovery-worker.ts,
 *      spawned exactly like fixtures/server.js is in other tests) picks
 *      up a real crawl job against the real fixture server.
 *   2. Once the job is genuinely `running` (a real crawl_jobs row
 *      flipped by the real handler), the worker process is SIGKILLed —
 *      not a graceful SIGTERM — simulating a hard crash mid-crawl.
 *   3. With NO process running, the job is shown to be stuck: the
 *      `crawl_jobs` row still reads "running" and pg-boss's own job row
 *      is still "active".
 *   4. A second worker process starts. pg-boss's OWN expiry/supervise
 *      mechanism (QueueOptions.expireInSeconds + the instance's
 *      superviseIntervalSeconds — a built-in pg-boss capability, not a
 *      bespoke "stuck job" sweep we wrote) is what notices the expired
 *      active job and retries it. The new worker's `work()` picks the
 *      retried job back up and runs the crawl to real completion.
 *
 * Production uses a 900s expiry / 60s supervise interval (see
 * CRAWL_WEBSITE_QUEUE_OPTIONS in src/lib/queue.ts) — far too slow to
 * exercise in a test. This test uses the exact same pg-boss mechanism
 * with much smaller numbers (10s expiry, 1s supervise/monitor/queue-cache
 * intervals) via the dedicated recovery-worker.ts entrypoint, which never
 * touches the real `crawl-website` queue's configuration.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { db, pool } from "@/db";
import { organizations } from "@/db/auth-schema";
import { websites, crawlJobs } from "@/db/app-schema";
import { startFixtureServer, type FixtureServerHandle } from "@/lib/test-support/fixture-server";

const APP_ROOT = path.resolve(process.cwd());
const QUEUE_NAME = `crawl-website-restart-proof-${Date.now()}`;

interface CapturedWorker {
  proc: ChildProcessWithoutNullStreams;
  lines: Array<Record<string, unknown>>;
  waitFor: (predicate: (line: Record<string, unknown>) => boolean, timeoutMs: number) => Promise<Record<string, unknown>>;
}

// IMPORTANT: `tsx`'s own CLI (node_modules/.bin/tsx, and `npx tsx` even
// more so) forks an internal child process to actually run the script —
// confirmed by inspecting its process tree here — so killing the CLI
// process does NOT kill the real worker; it gets reparented to init and
// keeps running, which would silently invalidate this entire proof (it
// did, the first few times this test was written: the "killed" worker
// kept processing jobs in the background). Spawning `node` directly with
// tsx's own require/loader flags (exactly what its CLI execs internally)
// runs the worker as a single, real OS process with no hidden fork, so
// `proc.kill("SIGKILL")` actually terminates it.
const TSX_PREFLIGHT = path.join(APP_ROOT, "node_modules", "tsx", "dist", "preflight.cjs");
const TSX_LOADER = path.join(APP_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

function spawnRecoveryWorker(extraEnv: Record<string, string>): CapturedWorker {
  const proc = spawn(
    process.execPath,
    [
      `--require=${TSX_PREFLIGHT}`,
      `--import=file://${TSX_LOADER}`,
      "src/lib/test-support/recovery-worker.ts",
    ],
    {
      cwd: APP_ROOT,
      env: { ...process.env, RECOVERY_WORKER_QUEUE: QUEUE_NAME, ...extraEnv },
    }
  );
  const lines: Array<Record<string, unknown>> = [];
  let buf = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    process.stderr.write(`[recovery-worker stdout pid=${proc.pid}] ${chunk}`);
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // non-JSON stdout noise — ignore
      }
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(`[recovery-worker stderr pid=${proc.pid}] ${chunk}`);
  });

  const waitFor = (predicate: (line: Record<string, unknown>) => boolean, timeoutMs: number) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const found = lines.find(predicate);
        if (found) return resolve(found);
        if (Date.now() > deadline) return reject(new Error(`Timed out waiting for log line (have: ${JSON.stringify(lines)})`));
        setTimeout(check, 150);
      };
      check();
    });

  return { proc, lines, waitFor };
}

async function waitForExit(proc: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit in time")), timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function pollUntil<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs: number, intervalMs = 300): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() > deadline) throw new Error(`pollUntil timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("worker restart recovery (real SIGKILL + real pg-boss expiry)", () => {
  let server: FixtureServerHandle;
  let orgId: string;
  let websiteId: string;
  let sender: PgBoss;

  beforeAll(async () => {
    // Just enough of a slow page that the crawl is still genuinely in
    // flight when we poll for "running" and SIGKILL — not so long that it
    // can't comfortably finish within RECOVERY_WORKER_EXPIRE_SECONDS on
    // its retry. (pg-boss enforces `expireInSeconds` as a real per-attempt
    // time budget enforced BY THE WORKER ITSELF — manager.js wraps the
    // handler call in `resolveWithinSeconds(..., expireInSeconds, ...)`
    // and aborts `job.signal` if it runs over — not only as a DB-side
    // "is this worker still alive" check. A too-short expiry would abort
    // the retry's own real crawl before it could finish; found exactly
    // that behavior while tuning this value.)
    server = await startFixtureServer(4214, { FIXTURE_SLOW_DELAY_MS: "2000" });

    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    orgId = `test-org-restart-${uniq}`;
    await db.insert(organizations).values({ id: orgId, name: "Restart Test Org", slug: `test-org-restart-${uniq}`, createdAt: new Date() });

    const [website] = await db
      .insert(websites)
      .values({ organizationId: orgId, url: `${server.origin}/`, verificationToken: "test-token" })
      .returning();
    websiteId = website.id;

    // supervise: false — this connection only sends the job; it must NOT
    // also run pg-boss's maintenance/expiry loop, or it would recover the
    // stuck job on its own and the test would no longer be isolating what
    // the RESTARTED WORKER does.
    sender = new PgBoss({ connectionString: process.env.DATABASE_URL!, schedule: false, supervise: false });
    await sender.start();
  }, 30_000);

  afterAll(async () => {
    await sender.stop();
    await server.stop();
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await pool.end();
  });

  it("leaves a SIGKILLed job in a recoverable (not permanently stuck) state, and a restarted worker finishes it", async () => {
    // --- 1. Worker A starts, real crawl job is sent and picked up ---
    const workerA = spawnRecoveryWorker({
      RECOVERY_WORKER_EXPIRE_SECONDS: "10",
      RECOVERY_WORKER_RETRY_LIMIT: "1",
      RECOVERY_WORKER_SUPERVISE_INTERVAL: "1",
    });
    await workerA.waitFor((l) => l.event === "ready", 15_000);

    const [job] = await db.insert(crawlJobs).values({ websiteId, status: "pending", trigger: "manual" }).returning();
    const pgBossJobId = await sender.send(QUEUE_NAME, {
      crawlJobId: job.id,
      websiteId,
      url: `${server.origin}/`,
      options: { allowlistOrigins: [server.origin] },
    });
    expect(pgBossJobId).toBeTruthy();

    await workerA.waitFor((l) => l.event === "job_started" && l.crawlJobId === job.id, 10_000);

    const runningRow = await pollUntil(
      async () => (await db.select().from(crawlJobs).where(eq(crawlJobs.id, job.id)))[0],
      (row) => row.status === "running",
      10_000
    );
    expect(runningRow.status).toBe("running");
    expect(runningRow.startedAt).toBeTruthy();

    // --- 2. SIGKILL worker A mid-crawl (not a graceful shutdown) ---
    workerA.proc.kill("SIGKILL");
    await waitForExit(workerA.proc, 10_000);

    // --- 3. Nothing updates the row/job on its own: it's stuck, but in a
    //        recoverable state (pg-boss still has it as "active", our
    //        row still says "running") — not silently lost. ---
    const [stuckRow] = await db.select().from(crawlJobs).where(eq(crawlJobs.id, job.id));
    expect(stuckRow.status).toBe("running");
    expect(stuckRow.finishedAt).toBeNull();

    const { rows: stuckBossRows } = await pool.query(
      `SELECT state, retry_count FROM pgboss.job WHERE id = $1`,
      [pgBossJobId]
    );
    expect(stuckBossRows[0].state).toBe("active");

    // Confirm it really doesn't heal on its own with no instance running:
    // wait past the 10s expiry window and re-check — still active/running.
    await new Promise((r) => setTimeout(r, 11_000));
    const { rows: stillStuckBossRows } = await pool.query(
      `SELECT state FROM pgboss.job WHERE id = $1`,
      [pgBossJobId]
    );
    expect(stillStuckBossRows[0].state).toBe("active");

    // --- 4. Restart: a fresh worker process starts. Its own supervise
    //        pass (pg-boss's built-in expiry monitor) notices the job's
    //        claim has expired, retries it, and this worker's work()
    //        picks the retried job back up and runs it to completion. ---
    const workerB = spawnRecoveryWorker({
      RECOVERY_WORKER_EXPIRE_SECONDS: "10",
      RECOVERY_WORKER_RETRY_LIMIT: "1",
      RECOVERY_WORKER_SUPERVISE_INTERVAL: "1",
    });
    try {
      await workerB.waitFor((l) => l.event === "ready", 15_000);

      const retriedStart = await workerB.waitFor(
        (l) => l.event === "job_started" && l.crawlJobId === job.id,
        20_000
      );
      // retryCount > 0 proves this is the SAME job resumed after expiry,
      // not a coincidentally-identical new one.
      expect(Number(retriedStart.retryCount)).toBeGreaterThan(0);

      const completedRow = await pollUntil(
        async () => (await db.select().from(crawlJobs).where(eq(crawlJobs.id, job.id)))[0],
        (row) => row.status === "completed" || row.status === "failed",
        60_000,
        500
      );
      expect(completedRow.status).toBe("completed");
      expect(completedRow.finishedAt).toBeTruthy();
    } finally {
      workerB.proc.kill("SIGKILL");
    }
  }, 120_000);
});
