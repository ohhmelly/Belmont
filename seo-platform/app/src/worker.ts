/**
 * Background job worker — same codebase as the Next.js app, different
 * entrypoint (per ARCHITECTURE.md). Docker Compose's `worker` service runs
 * this file instead of `next start`.
 *
 * Phase 2 scope: prove pg-boss (our Postgres-native job queue, chosen over
 * Redis/BullMQ so a single-server self-hosted deployment needs no extra
 * infra) can actually start against Postgres, stay up, and report healthy.
 * Registering real job handlers (crawl jobs, report generation, AI calls)
 * is Phase 3+ work — there is nothing to process yet.
 */
import "dotenv/config";
import http from "node:http";
import { PgBoss } from "pg-boss";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and configure it."
  );
}

const HEALTH_PORT = Number(process.env.WORKER_HEALTH_PORT ?? 3001);

let boss: PgBoss | null = null;
let ready = false;

async function main() {
  boss = new PgBoss({ connectionString });

  boss.on("error", (err) => {
    console.error("[worker] pg-boss error:", err);
  });

  await boss.start();
  ready = true;
  console.log("[worker] pg-boss started and connected to Postgres.");
  console.log(
    "[worker] No job handlers registered yet (Phase 2 foundation) — idling."
  );
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
