/**
 * Real proof of the retry policy configured for `crawl-website`
 * (CRAWL_WEBSITE_QUEUE_OPTIONS in src/lib/queue.ts: retryLimit 3,
 * retryDelay 5s, exponential backoff) — spec section 2: "a transient
 * failure... retries automatically rather than permanently failing on
 * the first error", proven with real pg-boss + real Postgres, not
 * asserted from config alone.
 *
 * Uses a dedicated queue created with the EXACT SAME
 * CRAWL_WEBSITE_QUEUE_OPTIONS (imported from queue.ts, not duplicated)
 * so this is genuinely testing the configured policy, just against a
 * throwaway queue name so it never collides with the real
 * `crawl-website` queue or other tests' state.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PgBoss } from "pg-boss";
import { CRAWL_WEBSITE_QUEUE_OPTIONS } from "@/lib/queue";

describe("crawl-website retry policy (real pg-boss + real Postgres)", () => {
  let boss: PgBoss;

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: process.env.DATABASE_URL!, schedule: false });
    await boss.start();
  }, 20_000);

  afterAll(async () => {
    await boss.stop();
  });

  it("retries a handler that fails twice, then succeeds on the 3rd attempt", async () => {
    const queueName = `retry-proof-success-${Date.now()}`;
    await boss.createQueue(queueName, CRAWL_WEBSITE_QUEUE_OPTIONS);

    const attempts: Array<{ retryCount: number; at: string }> = [];
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    await boss.work<{ marker: string }>(queueName, async ([job]) => {
      attempts.push({ retryCount: job.retryCount, at: new Date().toISOString() });
      if (job.retryCount < 2) {
        throw new Error(`transient failure #${job.retryCount + 1} (simulated)`);
      }
      resolveDone?.();
    });

    const jobId = await boss.send(queueName, { marker: "transient-then-ok" });
    expect(jobId).toBeTruthy();

    await done;
    // Give pg-boss a moment to persist the completion after the handler resolved.
    await new Promise((r) => setTimeout(r, 500));

    const finalJob = await boss.getJobById(queueName, jobId!);
    expect(finalJob).not.toBeNull();
    expect(finalJob!.state).toBe("completed");
    // 2 failures then success = 2 retries consumed, well within retryLimit 3.
    expect(finalJob!.retryCount).toBe(2);
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.retryCount)).toEqual([0, 1, 2]);

    await boss.offWork(queueName);
  }, 90_000);

  it("exhausts retries and lands in the terminal 'failed' state (not stuck, not silently dropped)", async () => {
    const queueName = `retry-proof-exhausted-${Date.now()}`;
    await boss.createQueue(queueName, CRAWL_WEBSITE_QUEUE_OPTIONS);

    let attemptCount = 0;
    await boss.work<{ marker: string }>(queueName, async () => {
      attemptCount++;
      throw new Error(`permanent failure (simulated), attempt ${attemptCount}`);
    });

    const jobId = await boss.send(queueName, { marker: "always-fails" });
    expect(jobId).toBeTruthy();

    // Poll for the terminal state. retryLimit 3 means 1 initial attempt + 3
    // retries = 4 total attempts before pg-boss marks it permanently failed.
    const deadline = Date.now() + 90_000;
    let finalJob = await boss.getJobById(queueName, jobId!);
    while (finalJob && finalJob.state !== "failed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      finalJob = await boss.getJobById(queueName, jobId!);
    }

    expect(finalJob).not.toBeNull();
    expect(finalJob!.state).toBe("failed");
    expect(finalJob!.retryCount).toBe(CRAWL_WEBSITE_QUEUE_OPTIONS.retryLimit);
    expect(attemptCount).toBe(CRAWL_WEBSITE_QUEUE_OPTIONS.retryLimit + 1);

    await boss.offWork(queueName);
  }, 120_000);
});
