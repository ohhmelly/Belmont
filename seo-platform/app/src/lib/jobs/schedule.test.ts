/**
 * Real proof that a recurring audit schedule actually fires (spec
 * section 1): runs the REAL production worker entrypoint (src/worker.ts,
 * as a real child process) against the real local Postgres, registers a
 * website's schedule through the real `applyWebsiteSchedule` helper
 * (src/lib/queue.ts) — the same function `setWebsiteSchedule` (the
 * dashboard server action) calls — and waits for pg-boss's own cron
 * timekeeper to actually create a new `crawl_jobs` row with
 * `trigger: "scheduled"`.
 *
 * Cron granularity is minutes, so this uses the shortest real cron
 * expression, "* * * * *" (every minute), via `applyWebsiteSchedule`'s
 * `cronOverride` parameter — exactly what the spec calls out ("you can
 * use a very short interval like every 1-2 minutes for the proof, then
 * document what a real daily/weekly/monthly cron expression looks
 * like"). The real cadence->cron mapping (CADENCE_CRON in queue.ts) is:
 *   daily   -> "0 3 * * *"   (03:00 UTC every day)
 *   weekly  -> "0 3 * * 1"   (03:00 UTC every Monday)
 *   monthly -> "0 3 1 * *"   (03:00 UTC on the 1st of the month)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import { db, pool } from "@/db";
import { organizations } from "@/db/auth-schema";
import { websites, crawlJobs } from "@/db/app-schema";
import { applyWebsiteSchedule } from "@/lib/queue";

const APP_ROOT = path.resolve(process.cwd());
const TSX_PREFLIGHT = path.join(APP_ROOT, "node_modules", "tsx", "dist", "preflight.cjs");
const TSX_LOADER = path.join(APP_ROOT, "node_modules", "tsx", "dist", "loader.mjs");
const HEALTH_PORT = 3911;

async function pollUntil<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs: number, intervalMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() > deadline) throw new Error(`pollUntil timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("recurring audit schedule (real worker.ts process + real pg-boss cron)", () => {
  let orgId: string;
  let websiteId: string;
  let worker: ChildProcessWithoutNullStreams;
  const workerLines: string[] = [];

  beforeAll(async () => {
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    orgId = `test-org-sched-${uniq}`;
    await db.insert(organizations).values({ id: orgId, name: "Schedule Test Org", slug: `test-org-sched-${uniq}`, createdAt: new Date() });

    // 127.0.0.1 is immediately rejected by the SSRF pre-flight (no
    // allowlist override) without any real network connection, so the
    // resulting crawl-website job completes near-instantly — this test
    // is about SCHEDULING firing, not about the crawl's own result.
    const [website] = await db
      .insert(websites)
      .values({ organizationId: orgId, url: "http://127.0.0.1:1/", verificationToken: "test-token", auditSchedule: "daily" })
      .returning();
    websiteId = website.id;

    // Real production worker entrypoint, as a real OS process (same
    // direct-node-with-tsx-flags technique as the other Phase 5 proofs,
    // so a later SIGKILL in afterAll actually terminates it).
    worker = spawn(
      process.execPath,
      [`--require=${TSX_PREFLIGHT}`, `--import=file://${TSX_LOADER}`, "src/worker.ts"],
      { cwd: APP_ROOT, env: { ...process.env, WORKER_HEALTH_PORT: String(HEALTH_PORT) } }
    );
    worker.stdout.on("data", (c: Buffer) => workerLines.push(...c.toString("utf8").split("\n").filter(Boolean)));
    worker.stderr.on("data", (c: Buffer) => workerLines.push(...c.toString("utf8").split("\n").filter(Boolean)));

    await pollUntil(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${HEALTH_PORT}/healthz`);
          return res.status;
        } catch {
          return 0;
        }
      },
      (status) => status === 200,
      20_000,
      500
    );
  }, 30_000);

  afterAll(async () => {
    worker.kill("SIGKILL");
    await applyWebsiteSchedule(websiteId, "none").catch(() => {});
    await db.delete(organizations).where(eq(organizations.id, orgId));
    // Hygiene: the scheduled fire enqueues a real job on the shared
    // `crawl-website`/`scheduled-audit-trigger` queues, which can
    // outlive this test's own rows if the worker hasn't drained it yet.
    // Not a correctness issue (an orphaned job just fails cleanly on the
    // now-missing FK and lands in pg-boss's terminal `failed` state —
    // see the completion report), but still cleaned up so it doesn't
    // clutter the real queues for later runs.
    await pool.query(`DELETE FROM pgboss.job WHERE name IN ('crawl-website', 'scheduled-audit-trigger') AND data->>'websiteId' = $1`, [websiteId]).catch(() => {});
    await pool.end();
  });

  it("fires a real crawl_jobs row with trigger=scheduled on an every-minute cron, via pg-boss's own scheduler", async () => {
    const before = new Date();

    // The same helper setWebsiteSchedule (the dashboard action) calls —
    // just with a 1-minute cron instead of the real "daily" expression,
    // so the proof doesn't take 24 hours.
    await applyWebsiteSchedule(websiteId, "daily", "* * * * *");

    const scheduledJob = await pollUntil(
      async () =>
        (
          await db
            .select()
            .from(crawlJobs)
            .where(and(eq(crawlJobs.websiteId, websiteId), eq(crawlJobs.trigger, "scheduled")))
        )[0] ?? null,
      (row) => row !== null,
      150_000,
      2_000
    );

    expect(scheduledJob).not.toBeNull();
    expect(scheduledJob!.trigger).toBe("scheduled");
    expect(scheduledJob!.createdAt.getTime()).toBeGreaterThan(before.getTime());

    const [website] = await db.select().from(websites).where(eq(websites.id, websiteId));
    expect(website.lastScheduledCrawlAt).not.toBeNull();
    expect(website.lastScheduledCrawlAt!.getTime()).toBeGreaterThan(before.getTime());

    // Real captured worker log lines around the fire, as evidence.
    const relevant = workerLines.filter(
      (l) => l.includes("scheduled-audit") || l.includes(scheduledJob!.id) || l.includes("enqueued")
    );
    expect(relevant.length).toBeGreaterThan(0);
  }, 170_000);
});
