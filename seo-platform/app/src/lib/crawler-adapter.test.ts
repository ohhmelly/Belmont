/**
 * Accuracy tests: run the REAL siteone-crawler binary (vendored at
 * ../vendor/siteone-crawler/siteone-crawler) against the REAL fixture
 * server (fixtures/server.js), through the real adapter pipeline
 * (SSRF pre-flight -> subprocess -> mapping -> supplementary pass), and
 * assert on the real, normalized findings produced. No mocking of the
 * crawler or the HTTP layer.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startFixtureServer, type FixtureServerHandle } from "./test-support/fixture-server";
import { runCrawl } from "./crawler-adapter";
import type { NormalizedFinding } from "./finding-types";

describe("crawler-adapter accuracy (real binary + real fixture server)", () => {
  let server: FixtureServerHandle;

  beforeAll(async () => {
    server = await startFixtureServer(4210, { FIXTURE_SLOW_DELAY_MS: "6000" });
  }, 15_000);

  afterAll(async () => {
    await server.stop();
  });

  let findings: NormalizedFinding[];
  let meta: Awaited<ReturnType<typeof runCrawl>>["meta"];

  beforeAll(async () => {
    const result = await runCrawl(`${server.origin}/`, {
      allowlistOrigins: [server.origin],
      requestTimeoutSec: 3,
      maxSupplementaryPages: 60,
    });
    findings = result.findings;
    meta = result.meta;
  }, 60_000);

  function findBy(category: string, urlIncludes?: string): NormalizedFinding[] {
    return findings.filter(
      (f) => f.category === category && (!urlIncludes || f.url.includes(urlIncludes))
    );
  }

  it("ran a real crawl successfully", () => {
    expect(meta.binaryVersion).toBeTruthy();
    expect(meta.crawledPageCount).toBeGreaterThan(10);
  });

  it("detects a page with no <title>", () => {
    const hits = findBy("missing_title", "/page-no-title");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("critical");
  });

  it("detects a page with no meta description", () => {
    const hits = findBy("missing_meta_description", "/page-no-meta-desc");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].severity).toBe("low");
  });

  it("detects duplicate titles across two distinct pages", () => {
    const a = findBy("duplicate_title", "/page-title-dup-a");
    const b = findBy("duplicate_title", "/page-title-dup-b");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].severity).toBe("medium");
  });

  it("detects duplicate meta descriptions across two distinct pages", () => {
    const a = findBy("duplicate_meta_description", "/page-meta-dup-a");
    const b = findBy("duplicate_meta_description", "/page-meta-dup-b");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("detects a broken link (404)", () => {
    const hits = findBy("broken_link", "/this-does-not-exist");
    expect(hits).toHaveLength(1);
    expect(hits[0].httpStatus).toBe(404);
    expect(hits[0].severity).toBe("high");
  });

  it("detects a 500 server error page", () => {
    const hits = findBy("server_error", "/error-page");
    expect(hits).toHaveLength(1);
    expect(hits[0].httpStatus).toBe(500);
    expect(hits[0].severity).toBe("critical");
  });

  it("detects the 3+ hop redirect chain", () => {
    const hits = findBy("redirect_chain", "/redirect-chain-1");
    expect(hits).toHaveLength(1);
    const chain = hits[0].evidence.chain as string[];
    expect(chain.length).toBeGreaterThanOrEqual(4); // chain-1 -> 2 -> 3 -> 4
  });

  it("detects the redirect loop", () => {
    const hits = findBy("redirect_loop", "/redirect-loop-a");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("high");
  });

  it("detects the slow endpoint as a timeout", () => {
    const hits = findBy("timeout", "/slow");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("high");
  });

  it("detects the canonical conflict chain (A -> B -> C)", () => {
    // The finding's primary `url` is whichever page in the cycle the
    // supplementary pass happened to process first (Map iteration order
    // follows crawl-discovery order, not A/B/C order) — so assert on the
    // chain membership in evidence rather than which node is "first".
    const hits = findBy("canonical_conflict");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const hit = hits[0];
    expect(hit.severity).toBe("high");
    const chain = hit.evidence.chain as string[];
    expect(chain.some((u) => u.includes("/canonical-a"))).toBe(true);
    expect(chain.some((u) => u.includes("/canonical-b"))).toBe(true);
    expect(chain.some((u) => u.includes("/canonical-c"))).toBe(true);
    expect(hit.evidence.loop).toBe(true);
  });

  it("respects robots.txt: the disallowed page is NOT reported as broken/missing anything", () => {
    const anyFindingForPrivatePage = findings.filter((f) => f.url.includes("/private/secret"));
    expect(anyFindingForPrivatePage).toHaveLength(0);
    expect(meta.skippedByRobots).toContain("/private/secret");
  });

  it("discovers the sitemap and finds orphan pages only present there", () => {
    expect(meta.sitemapUrlCount).toBeGreaterThanOrEqual(300);
    const orphan = findBy("orphan_page", "/orphan-page");
    expect(orphan).toHaveLength(1);
  });

  it("detects malformed HTML", () => {
    const hits = findBy("malformed_html", "/malformed-html");
    expect(hits).toHaveLength(1);
  });

  it("detects invalid JSON-LD structured data, and does not flag the valid one", () => {
    const invalid = findBy("structured_data_invalid", "/structured-data-invalid");
    expect(invalid).toHaveLength(1);
    const falselyFlaggedValid = findBy("structured_data_invalid", "/structured-data-valid");
    expect(falselyFlaggedValid).toHaveLength(0);
  });

  it("detects the non-reciprocal hreflang alternate", () => {
    const hits = findBy("hreflang_not_reciprocal", "/hreflang-broken");
    expect(hits).toHaveLength(1);
  });

  it("SSRF: blocks the malicious redirect to a private/link-local address instead of following it", () => {
    const blocked = findBy("ssrf_blocked_redirect", "/malicious-redirect");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].severity).toBe("critical");
    expect(meta.blockedSsrfRedirects.some((b) => b.targetUrl.includes("169.254.169.254"))).toBe(
      true
    );

    // The private target must never appear as something the crawl actually reached.
    const everTouchedPrivateTarget = findings.some((f) => f.url.includes("169.254.169.254"));
    expect(everTouchedPrivateTarget).toBe(false);
  });
});
