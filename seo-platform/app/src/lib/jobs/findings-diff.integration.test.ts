/**
 * End-to-end proof of the historical-comparison feature (Phase 5, spec
 * section 5): runs two REAL crawls (real siteone-crawler subprocess, real
 * Postgres) against a tiny fixture server whose content is deliberately
 * changed between the two crawls, then asserts `computeCrawlDiff` reports
 * the expected NEW / RESOLVED / PERSISTING findings from the real
 * `findings` rows each crawl wrote.
 *
 * This is a small, dedicated fixture server (not fixtures/server.js,
 * which Phase 3/4 tests depend on exactly as-is) so this test can mutate
 * its content between crawls without touching shared test fixtures.
 *
 * Fixture plan:
 *   v1: "/" links to "/stable", "/fixable", "/broken-v1".
 *       - "/stable" has no <title>           -> missing_title(/stable)   [persists]
 *       - "/fixable" has no <title>           -> missing_title(/fixable) [resolved in v2]
 *       - "/broken-v1" doesn't exist (404)    -> broken_link(/broken-v1) [resolved: v2 removes the link]
 *   v2: "/" links to "/stable", "/fixable" only.
 *       - "/stable" still has no <title>      -> missing_title(/stable)   [persists]
 *       - "/fixable" now has a title but no meta description
 *                                              -> missing_meta_description(/fixable) [NEW]
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { eq } from "drizzle-orm";
import { db, pool } from "@/db";
import { organizations } from "@/db/auth-schema";
import { websites, crawlJobs } from "@/db/app-schema";
import { handleCrawlWebsiteJob } from "./crawl-website";
import { computeCrawlDiff, findingKey } from "../findings-diff";

let version: 1 | 2 = 1;

function page(body: string, extraHead = ""): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${extraHead}</head><body>${body}</body></html>`;
}

/** siteone-crawler only parses links out of a response it recognizes as HTML — an explicit Content-Type is required (a bare res.end() defaults to none, which it treats as opaque). */
function sendHtml(res: http.ServerResponse, body: string): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/") {
    const links =
      version === 1
        ? `<a href="/stable">stable</a><a href="/fixable">fixable</a><a href="/broken-v1">broken</a>`
        : `<a href="/stable">stable</a><a href="/fixable">fixable</a>`;
    sendHtml(res, page(`<h1>Home v${version}</h1>${links}`, `<title>Home</title>`));
    return;
  }
  if (url === "/stable") {
    // No <title> in either version -> missing_title persists both crawls.
    sendHtml(res, page(`<h1>Stable page</h1>`));
    return;
  }
  if (url === "/fixable") {
    if (version === 1) {
      // No <title> (but HAS a meta description, so that finding doesn't
      // also fire here in v1) -> missing_title(/fixable), resolved in v2.
      sendHtml(
        res,
        page(`<h1>Fixable page v1</h1>`, `<meta name="description" content="Fixable page, v1.">`)
      );
    } else {
      // Has a title now, but no meta description -> NEW missing_meta_description(/fixable).
      sendHtml(res, page(`<h1>Fixable page v2</h1>`, `<title>Fixable Page</title>`));
    }
    return;
  }
  if (url === "/robots.txt") {
    res.setHeader("Content-Type", "text/plain");
    res.end("User-agent: *\nAllow: /\n");
    return;
  }
  res.statusCode = 404;
  sendHtml(res, page(`<h1>404</h1>`, `<title>404 Not Found</title>`));
});

let origin: string;
let orgId: string;
let websiteId: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(4212, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:4212";

  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  orgId = `test-org-diff-${uniq}`;
  await db.insert(organizations).values({
    id: orgId,
    name: "Diff Test Org",
    slug: `test-org-diff-${uniq}`,
    createdAt: new Date(),
  });

  const [website] = await db
    .insert(websites)
    .values({ organizationId: orgId, url: `${origin}/`, verificationToken: "test-token" })
    .returning();
  websiteId = website.id;
}, 20_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pool.end();
});

async function runCrawlAgainst(websiteIdArg: string, urlArg: string): Promise<string> {
  const [job] = await db.insert(crawlJobs).values({ websiteId: websiteIdArg, status: "pending" }).returning();
  await handleCrawlWebsiteJob({
    crawlJobId: job.id,
    websiteId: websiteIdArg,
    url: urlArg,
    options: { allowlistOrigins: [origin], maxPages: 10 },
  });
  const [row] = await db.select().from(crawlJobs).where(eq(crawlJobs.id, job.id));
  expect(row.status).toBe("completed");
  return job.id;
}

describe("historical comparison between crawls (real crawls + real Postgres)", () => {
  it("diffs two real crawls of changed fixture content into new/resolved/persisting findings", async () => {
    version = 1;
    await runCrawlAgainst(websiteId, `${origin}/`);

    version = 2;
    await runCrawlAgainst(websiteId, `${origin}/`);

    const diff = await computeCrawlDiff(websiteId);
    expect(diff).not.toBeNull();
    if (!diff) return;

    const newKeys = diff.newFindings.map(findingKey);
    const resolvedKeys = diff.resolvedFindings.map(findingKey);
    const persistingKeys = diff.persistingFindings.map(findingKey);

    // NEW: /fixable now has a title, but gained a missing-meta-description finding.
    expect(newKeys).toContain("missing_meta_description::" + `${origin}/fixable`);

    // RESOLVED: /fixable's old missing_title is gone, and /broken-v1's broken_link
    // is gone (the link to it was removed, so v2 never even requests it).
    expect(resolvedKeys).toContain("missing_title::" + `${origin}/fixable`);
    expect(resolvedKeys.some((k) => k.startsWith("broken_link::"))).toBe(true);

    // PERSISTS: /stable's missing_title is present in both crawls.
    expect(persistingKeys).toContain("missing_title::" + `${origin}/stable`);

    // Sanity: nothing in resolved+persisting should also show up as new, and vice versa.
    for (const k of newKeys) {
      expect(resolvedKeys).not.toContain(k);
      expect(persistingKeys).not.toContain(k);
    }
  }, 90_000);
});
