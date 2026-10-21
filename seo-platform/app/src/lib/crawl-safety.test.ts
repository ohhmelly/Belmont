import { describe, it, expect } from "vitest";
import http from "node:http";
import {
  isDisallowedIp,
  resolveValidatedAddress,
  validateUrlForCrawl,
  safeFetch,
  CrawlSafetyError,
} from "./crawl-safety";

describe("isDisallowedIp", () => {
  it.each([
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.15.255.255", false], // just outside 172.16/12
    ["172.32.0.1", false], // just outside
    ["192.168.1.1", true],
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["0.0.0.0", true],
    ["169.254.169.254", true], // cloud metadata
    ["169.254.0.1", true],
    ["224.0.0.1", true], // multicast
    ["255.255.255.255", true],
    ["8.8.8.8", false], // public DNS
    ["1.1.1.1", false],
    ["93.184.216.34", false], // example.com-ish public IP
  ])("IPv4 %s -> disallowed=%s", (ip, expected) => {
    expect(isDisallowedIp(ip)).toBe(expected);
  });

  it.each([
    ["::1", true],
    ["::", true],
    ["fc00::1", true],
    ["fd12:3456:789a::1", true],
    ["fe80::1", true],
    ["ff02::1", true], // multicast
    ["::ffff:127.0.0.1", true], // IPv4-mapped loopback
    ["::ffff:10.0.0.5", true], // IPv4-mapped private
    ["::ffff:8.8.8.8", false], // IPv4-mapped public
    ["2001:4860:4860::8888", false], // public (Google DNS v6)
  ])("IPv6 %s -> disallowed=%s", (ip, expected) => {
    expect(isDisallowedIp(ip)).toBe(expected);
  });

  it("treats malformed input as disallowed", () => {
    expect(isDisallowedIp("not-an-ip")).toBe(true);
    expect(isDisallowedIp("999.999.999.999")).toBe(true);
  });
});

describe("resolveValidatedAddress", () => {
  it("rejects literal localhost", async () => {
    await expect(resolveValidatedAddress("localhost")).rejects.toThrow(CrawlSafetyError);
  });

  it("rejects literal private IPv4", async () => {
    await expect(resolveValidatedAddress("127.0.0.1")).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(resolveValidatedAddress("10.0.0.5")).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(resolveValidatedAddress("192.168.0.1")).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    await expect(resolveValidatedAddress("169.254.169.254")).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });

  it("allows a disallowed address when explicitly marked allowed (test-only escape hatch)", async () => {
    const target = await resolveValidatedAddress("127.0.0.1", { allowed: true });
    expect(target.address).toBe("127.0.0.1");
  });

  it("rejects a hostname that fails to resolve", async () => {
    await expect(
      resolveValidatedAddress("this-host-should-never-resolve.invalid-tld-xyz123")
    ).rejects.toMatchObject({ code: "DNS_FAILED" });
  });

  it("resolves a real public hostname to a public address", async () => {
    // dns.lookup for a well-known public domain should resolve and pass validation.
    const target = await resolveValidatedAddress("one.one.one.one");
    expect(isDisallowedIp(target.address)).toBe(false);
  });
});

describe("validateUrlForCrawl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(validateUrlForCrawl("ftp://example.com/file")).rejects.toMatchObject({
      code: "INVALID_SCHEME",
    });
    await expect(validateUrlForCrawl("file:///etc/passwd")).rejects.toMatchObject({
      code: "INVALID_SCHEME",
    });
  });

  it("rejects malformed URLs", async () => {
    await expect(validateUrlForCrawl("not a url at all")).rejects.toMatchObject({
      code: "INVALID_URL",
    });
  });

  it("rejects a URL pointing at a private IP", async () => {
    await expect(validateUrlForCrawl("http://127.0.0.1:9999/")).rejects.toMatchObject({
      code: "PRIVATE_ADDRESS",
    });
  });

  it("rejects localhost even with a path", async () => {
    await expect(validateUrlForCrawl("http://localhost:3000/admin")).rejects.toMatchObject({
      code: "DISALLOWED_HOST",
    });
  });

  it("allows a private-IP URL whose exact origin is allowlisted", async () => {
    const { url } = await validateUrlForCrawl("http://127.0.0.1:4100/", {
      allowlistOrigins: ["http://127.0.0.1:4100"],
    });
    expect(url.hostname).toBe("127.0.0.1");
  });

  it("does NOT allow a different port on the same host when only one origin is allowlisted", async () => {
    await expect(
      validateUrlForCrawl("http://127.0.0.1:4101/", {
        allowlistOrigins: ["http://127.0.0.1:4100"],
      })
    ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
  });
});

/**
 * These tests spin up a tiny local HTTP server to exercise safeFetch's
 * redirect-revalidation, size cap, and timeout behavior end-to-end,
 * using the allowlist test-only escape hatch for the server's own origin
 * (loopback is otherwise always rejected — see tests above).
 */
describe("safeFetch (against a local test server)", () => {
  async function withServer(
    handler: http.RequestListener,
    fn: (origin: string) => Promise<void>
  ) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const origin = `http://127.0.0.1:${port}`;
    try {
      await fn(origin);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("fetches a simple 200 page through the allowlist", async () => {
    await withServer(
      (req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("hello world");
      },
      async (origin) => {
        const result = await safeFetch(`${origin}/`, { allowlistOrigins: [origin] });
        expect(result.status).toBe(200);
        expect(result.body.toString()).toBe("hello world");
      }
    );
  });

  it("follows a same-origin redirect chain and records it", async () => {
    await withServer(
      (req, res) => {
        if (req.url === "/a") {
          res.writeHead(302, { Location: "/b" });
          res.end();
        } else if (req.url === "/b") {
          res.writeHead(200);
          res.end("final");
        } else {
          res.writeHead(404);
          res.end();
        }
      },
      async (origin) => {
        const result = await safeFetch(`${origin}/a`, { allowlistOrigins: [origin] });
        expect(result.status).toBe(200);
        expect(result.body.toString()).toBe("final");
        expect(result.redirectChain).toHaveLength(1);
      }
    );
  });

  it("blocks a redirect to a private address NOT in the allowlist (SSRF via redirect)", async () => {
    await withServer(
      (req, res) => {
        // Redirects to a private address outside the test server's own
        // allowlisted origin — simulating a malicious/compromised site
        // trying to make our crawler reach an internal service.
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      },
      async (origin) => {
        await expect(
          safeFetch(`${origin}/malicious-redirect`, { allowlistOrigins: [origin] })
        ).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
      }
    );
  });

  it("blocks a redirect loop via the redirect cap", async () => {
    await withServer(
      (req, res) => {
        const other = req.url === "/loop1" ? "/loop2" : "/loop1";
        res.writeHead(302, { Location: other });
        res.end();
      },
      async (origin) => {
        await expect(
          safeFetch(`${origin}/loop1`, { allowlistOrigins: [origin], maxRedirects: 3 })
        ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
      }
    );
  });

  it("caps response size instead of reading an unbounded body", async () => {
    await withServer(
      (req, res) => {
        res.writeHead(200);
        // Write far more than our tiny cap.
        res.end(Buffer.alloc(1024, "x"));
      },
      async (origin) => {
        const result = await safeFetch(`${origin}/`, {
          allowlistOrigins: [origin],
          maxBytes: 100,
        });
        expect(result.truncated).toBe(true);
        expect(result.body.length).toBeLessThanOrEqual(100 + 64); // allow one chunk's slop
      }
    );
  });

  it("times out on a slow response", async () => {
    await withServer(
      (req, res) => {
        // Never respond.
        setTimeout(() => {
          res.writeHead(200);
          res.end("too late");
        }, 5000);
      },
      async (origin) => {
        await expect(
          safeFetch(`${origin}/slow`, { allowlistOrigins: [origin], timeoutMs: 200 })
        ).rejects.toThrow();
      }
    );
  }, 10_000);
});
