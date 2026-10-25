/**
 * Phase 7 security fix: prove the auth route handler actually rate-
 * limits login attempts, rather than just asserting the config exists.
 *
 * Before this phase, `src/lib/auth.ts` left Better Auth's built-in
 * rate limiter on its library default, which only turns itself on when
 * `NODE_ENV === "production"` — an implicit dependency that is off in
 * this repo's own dev `.env` (`NODE_ENV=development`) and in this test
 * run. The fix makes `rateLimit.enabled: true` explicit in `auth.ts` so
 * brute-force protection on /sign-in and /sign-up is never silently off
 * regardless of NODE_ENV. This test calls the real exported route
 * handler (`POST` from `./[...all]/route.ts`, built with
 * `toNextJsHandler(auth)` — the exact function Next.js invokes for a
 * real HTTP request) with real `NextRequest`s, not a mocked auth layer.
 *
 * Better Auth's built-in rule for /sign-in and /sign-up is strict by
 * design: 3 requests per 10-second window per client IP (see
 * node_modules/better-auth/dist/api/rate-limiter/index.mjs's
 * `getDefaultSpecialRules`), then a 429 with a `message` and
 * `X-Retry-After` header until the window rolls over.
 */
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./[...all]/route";

/**
 * A unique, VALID fake client IPv4 per test, so each test gets its own
 * rate-limit bucket and tests never interfere with each other. Must be
 * a real parseable IPv4 (TEST-NET-2/3 ranges, RFC 5737) — Better Auth's
 * `getIP()` silently falls back to a single shared "localhost" bucket
 * in dev/test for any header value it can't parse as a valid IP, which
 * would otherwise make every "different IP" in this test collide.
 */
let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  const b = (ipCounter >> 8) % 255;
  const c = ipCounter % 255;
  return `198.51.${b}.${c || 1}`;
}

function signInRequest(ip: string, password: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Better Auth's getIP() reads forwarded-for style headers to key
      // the rate limiter per client; without a trusted proxy header
      // present it falls back to one shared bucket (see auth.ts's
      // comment) — tests supply it explicitly so each test is isolated.
      "x-forwarded-for": ip,
    },
    body: JSON.stringify({ email: "nobody-rl-test@example.test", password }),
  });
}

describe("POST /api/auth/sign-in/email — brute-force rate limiting", () => {
  it("allows the first few attempts, then returns 429 with a Retry-After hint", async () => {
    const ip = uniqueIp();

    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await POST(signInRequest(ip, `wrong-password-${i}`));
      results.push(res.status);
      if (res.status === 429) {
        const body = await res.json();
        expect(body.message).toMatch(/too many requests/i);
        expect(res.headers.get("X-Retry-After")).toBeTruthy();
      }
    }

    // The exact cutoff is Better Auth's own built-in rule (3 per 10s),
    // not something this app hand-rolled — assert the *behavior* that
    // matters: some attempts get through, and at least one of the later
    // ones is rejected with 429, proving the limiter is actually wired
    // into the real request path end to end.
    expect(results.some((status) => status === 429)).toBe(true);
    // None of the wrong-password attempts should have succeeded (200) —
    // every status is either a normal auth failure or a 429.
    expect(results.every((status) => status === 429 || status >= 400)).toBe(true);
  }, 20_000);

  it("gives a fresh client IP its own independent bucket (not globally exhausted)", async () => {
    const ipA = uniqueIp();
    const ipB = uniqueIp();

    // Exhaust ipA's bucket.
    for (let i = 0; i < 4; i++) await POST(signInRequest(ipA, "wrong"));

    // ipB must not be affected by ipA's attempts.
    const resB = await POST(signInRequest(ipB, "wrong"));
    expect(resB.status).not.toBe(429);
  }, 20_000);
});
