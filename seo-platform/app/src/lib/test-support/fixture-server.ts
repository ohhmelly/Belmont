/**
 * Test helper: start/stop the fixtures/server.js HTTP server as a child
 * process for accuracy tests, on a caller-chosen port so parallel test
 * files don't collide.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export interface FixtureServerHandle {
  port: number;
  origin: string;
  stop: () => Promise<void>;
}

const FIXTURES_DIR = path.resolve(process.cwd(), "..", "fixtures");

async function waitForReady(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/robots.txt`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Fixture server at ${origin} did not become ready within ${timeoutMs}ms`);
}

export async function startFixtureServer(
  port: number,
  env: Record<string, string> = {}
): Promise<FixtureServerHandle> {
  const origin = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn("node", ["server.js"], {
    cwd: FIXTURES_DIR,
    env: { ...process.env, FIXTURE_PORT: String(port), ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });

  await waitForReady(origin, 10_000);

  return {
    port,
    origin,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
        setTimeout(resolve, 2000); // don't hang the test suite if the kill is slow
      }),
  };
}
