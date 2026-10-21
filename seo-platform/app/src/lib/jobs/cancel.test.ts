/**
 * Real proof of job cancellation (spec section 2): a pending job is
 * cancelled before any worker picks it up (via the real `cancelCrawl`
 * dashboard action end-to-end), and a currently-RUNNING job is cancelled
 * mid-crawl, proving (a) pg-boss's own job row reaches the terminal
 * `cancelled` state and (b) the `crawl_jobs` row reflects `cancelled` and
 * is never clobbered back to completed/failed by the very attempt that
 * was cancelled (the `ne(status, 'cancelled')` guard added to
 * src/lib/jobs/crawl-website.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { db, pool } from "@/db";
import { organizations } from "@/db/auth-schema";
import { websites, crawlJobs } from "@/db/app-schema";
import { enqueueCrawl, getBoss, CRAWL_WEBSITE_QUEUE } from "@/lib/queue";
import { cancelCrawl } from "@/app/dashboard/actions";
import { startFixtureServer, type FixtureServerHandle } from "@/lib/test-support/fixture-server";

const APP_ROOT = path.resolve(process.cwd());
const TSX_PREFLIGHT = path.join(APP_ROOT, "node_modules", "tsx", "dist", "preflight.cjs");
const TSX_LOADER = path.join(APP_ROOT, "node_modules", "tsx", "dist", "loader.mjs");

function spawnRecoveryWorker(queueName: string): { proc: ChildProcessWithoutNullStreams; lines: string[] } {
  const proc = spawn(
    process.execPath,
    [`--require=${TSX_PREFLIGHT}`, `--import=file://${TSX_LOADER}`, "src/lib/test-support/recovery-worker.ts"],
    {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        RECOVERY_WORKER_QUEUE: queueName,
        RECOVERY_WORKER_EXPIRE_SECONDS: "60",
        RECOVERY_WORKER_RETRY_LIMIT: "0",
      },
    }
  );
  const lines: string[] = [];
  proc.stdout.on("data", (c: Buffer) => {
    for (const line of c.toString("utf8").split("\n")) if (line.trim()) lines.push(line);
  });
  return { proc, lines };
}

async function pollUntil<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() > deadline) throw new Error(`pollUntil timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe("crawl job cancellation (real pg-boss + real Postgres)", () => {
  let orgId: string;
  let websiteId: string;

  beforeAll(async () => {
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    orgId = `test-org-cancel-${uniq}`;
    await db.insert(organizations).values({ id: orgId, name: "Cancel Test Org", slug: `test-org-cancel-${uniq}`, createdAt: new Date() });
    const [website] = await db
      .insert(websites)
      .values({ organizationId: orgId, url: "https://example.invalid/", verificationToken: "test-token" })
      .returning();
    websiteId = website.id;
  }, 20_000);

  afterAll(async () => {
    // Hygiene: test 1 cancels a real job on the shared `crawl-website`
    // queue; it's terminal (cancelled) and harmless, but clean it up so
    // it doesn't clutter the real queue for later runs.
    await pool.query(`DELETE FROM pgboss.job WHERE name = 'crawl-website' AND data->>'websiteId' = $1`, [websiteId]).catch(() => {});
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await pool.end();
  });

  it("cancels a pending job (never picked up) end-to-end via the real cancelCrawl action", async () => {
    const [job] = await db.insert(crawlJobs).values({ websiteId, status: "pending", trigger: "manual" }).returning();
    const pgBossJobId = await enqueueCrawl({ crawlJobId: job.id, websiteId, url: "https://example.invalid/" });
    expect(pgBossJobId).toBeTruthy();
    await db.update(crawlJobs).set({ pgBossJobId }).where(eq(crawlJobs.id, job.id));

    const formData = new FormData();
    formData.set("crawlJobId", job.id);
    formData.set("websiteId", websiteId);
    try {
      await cancelCrawl(formData);
    } catch (err) {
      // cancelCrawl's real work (the DB update + pg-boss cancel, both
      // asserted below) runs and completes BEFORE its trailing
      // revalidatePath() call — which throws outside a real Next.js
      // request scope, a test-harness artifact of calling a "use server"
      // action directly, not a failure of anything this test is proving.
      if (!(err instanceof Error) || !err.message.includes("static generation store missing")) throw err;
    }

    const [row] = await db.select().from(crawlJobs).where(eq(crawlJobs.id, job.id));
    expect(row.status).toBe("cancelled");
    expect(row.error).toBe("Cancelled by user");

    const boss = await getBoss();
    const bossJob = await boss.getJobById(CRAWL_WEBSITE_QUEUE, pgBossJobId!);
    expect(bossJob).not.toBeNull();
    expect(bossJob!.state).toBe("cancelled");
  }, 30_000);

  it("cancels a RUNNING job mid-crawl, and the aborted attempt never clobbers the cancelled status", async () => {
    const queueName = `cancel-proof-${Date.now()}`;
    const server: FixtureServerHandle = await startFixtureServer(4215, { FIXTURE_SLOW_DELAY_MS: "20000" });
    const worker = spawnRecoveryWorker(queueName);

    try {
      // Wait for the worker to be ready.
      await pollUntil(async () => worker.lines.some((l) => l.includes('"event":"ready"')), (ok) => ok, 15_000);

      const [job] = await db.insert(crawlJobs).values({ websiteId, status: "pending", trigger: "manual" }).returning();

      const sender = new PgBoss({ connectionString: process.env.DATABASE_URL!, schedule: false, supervise: false });
      await sender.start();
      const pgBossJobId = await sender.send(queueName, {
        crawlJobId: job.id,
        websiteId,
        url: `${server.origin}/`,
        options: { allowlistOrigins: [server.origin] },
      });
      expect(pgBossJobId).toBeTruthy();

      await pollUntil(
        async () => (await db.select().from(crawlJobs).where(eq(crawlJobs.id, job.id)))[0],
        (row) => row.status === "running",
        10_000
      );

      // Cancel it while it's genuinely running.
      await sender.cancel(queueName, pgBossJobId!);
      await db
        .update(crawlJobs)
        .set({ status: "cancelled", finishedAt: new Date(), error: "Cancelled by user" })
        .where(eq(crawlJobs.id, job.id));

      const bossJobRightAway = await sender.getJobById(queueName, pgBossJobId!);
      expect(bossJobRightAway!.state).toBe("cancelled");

      // Give the aborted attempt a few seconds to reach its catch block and
      // try to write "failed" (it must not succeed, thanks to the
      // ne(status, 'cancelled') guard in crawl-website.ts).
      await new Promise((r) => setTimeout(r, 5_000));
      const [finalRow] = await db.select().from(crawlJobs).where(eq(crawlJobs.id, job.id));
      expect(finalRow.status).toBe("cancelled");

      await sender.stop();
    } finally {
      worker.proc.kill("SIGKILL");
      await server.stop();
    }
  }, 60_000);
});
