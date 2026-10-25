/**
 * Adapter boundary between our app and the vendored `siteone-crawler`
 * binary (see docs/INTEGRATION_ARCHITECTURE.md for the full writeup of
 * what each source covers).
 *
 * Responsibilities, strictly in this order:
 *  1. Run the SSRF/network-safety pre-flight (crawl-safety.ts) on the
 *     user-supplied start URL. The crawler binary is NEVER invoked with
 *     an unvalidated URL.
 *  2. Invoke siteone-crawler as a subprocess, scoped with `--include-regex`
 *     to the exact validated origin so it can never queue or follow a
 *     request — including a redirect target — outside that origin, no
 *     matter what a (possibly compromised) page tells it to fetch. This
 *     is required in addition to step 1: step 1 only validates the
 *     starting URL, and siteone-crawler's own redirect-following has no
 *     per-hop safety check of its own (confirmed empirically — see
 *     docs/INTEGRATION_ARCHITECTURE.md's "SSRF via redirect" section).
 *  3. Parse siteone-crawler's `--output=json` report and map it into our
 *     normalized `NormalizedFinding` schema.
 *  4. Run the supplementary rule-engine pass (supplementary-rules.ts) for
 *     the specific gaps siteone-crawler's JSON output does not cover.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  validateUrlForCrawl,
  isDisallowedIp,
  CrawlSafetyError,
  safeFetch,
  type CrawlSafetyOptions,
} from "./crawl-safety";
import type { NormalizedFinding } from "./finding-types";
import {
  fetchPageSnapshots,
  fetchSitemapUrls,
  detectCanonicalConflicts,
  detectOrphanPages,
  detectHreflangIssues,
  detectStructuredDataIssues,
  detectMalformedHtml,
  detectAiCrawlerAccessIssues,
} from "./supplementary-rules";

const execFileAsync = promisify(execFile);

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  jsRendering?: boolean;
  requestTimeoutSec?: number;
  processTimeoutMs?: number;
  /** Test-only SSRF allowlist override — see crawl-safety.ts. Never set for a real user crawl. */
  allowlistOrigins?: string[];
  maxSupplementaryPages?: number;
  /**
   * Phase 5: an AbortSignal (typically a pg-boss job's own `job.signal`,
   * which fires when the job is cancelled or its worker loses its claim)
   * that aborts the crawler subprocess mid-run via Node's `execFile`
   * `signal` option. Optional and backward compatible — omitted, nothing
   * changes from Phase 3/4 behavior.
   */
  signal?: AbortSignal;
}

export interface CrawlAdapterResult {
  findings: NormalizedFinding[];
  meta: {
    startUrl: string;
    crawledPageCount: number;
    skippedByRobots: string[];
    blockedSsrfRedirects: Array<{ fromUrl: string; targetUrl: string }>;
    sitemapUrlCount: number;
    jsRenderingRequested: boolean;
    jsRenderingUsed: boolean;
    jsRenderingUnavailableReason?: string;
    exitCode: number | null;
    binaryVersion?: string;
    /** llms.txt (https://llmstxt.org) existence probe — see supplementary-rules.ts's detectAiCrawlerAccessIssues. */
    llmsTxtFound: boolean;
  };
}

function resolveBinaryPath(): string {
  if (process.env.CRAWLER_BIN_PATH) return process.env.CRAWLER_BIN_PATH;
  // app/ is the Next.js project root at runtime. The vendored binary is
  // platform-specific: vendor/siteone-crawler/siteone-crawler is a Linux
  // ELF build (used in Docker/the Linux deployment target), and
  // vendor/siteone-crawler-windows/siteone-crawler.exe is the official
  // Windows release (used for local Windows development per the
  // project's Windows-dev/Linux-prod requirement). Picking the wrong one
  // fails every crawl with a confusing ENOENT on the *output* file, not
  // an obvious "wrong binary" error, since the subprocess never starts —
  // see docs/INTEGRATION_ARCHITECTURE.md for how this was discovered.
  if (process.platform === "win32") {
    return path.resolve(process.cwd(), "..", "vendor", "siteone-crawler-windows", "siteone-crawler.exe");
  }
  return path.resolve(process.cwd(), "..", "vendor", "siteone-crawler", "siteone-crawler");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface SiteoneRow {
  [key: string]: unknown;
}

interface SiteoneReport {
  crawler?: { version?: string };
  results?: SiteoneRow[];
  tables?: Record<string, { rows: SiteoneRow[] }>;
}

function str(row: SiteoneRow, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

/** Pure mapping function: siteone-crawler's parsed JSON report -> our normalized findings. Exported for unit testing without a subprocess. */
export function mapSiteoneReportToFindings(
  report: SiteoneReport,
  origin: string,
  allowlistOrigins: string[] = []
): {
  findings: NormalizedFinding[];
  discoveredUrls: Set<string>;
  skippedByRobots: string[];
  blockedSsrfRedirects: Array<{ fromUrl: string; targetUrl: string }>;
} {
  const findings: NormalizedFinding[] = [];
  const results = report.results ?? [];
  const tables = report.tables ?? {};

  const discoveredUrls = new Set<string>();
  for (const r of results) {
    const url = str(r, "url");
    if (url) discoveredUrls.add(url);
  }

  // --- seo table: per-page title/description/robots ---
  const seoRows = tables.seo?.rows ?? [];
  const pageByUrl = new Map<string, SiteoneRow>();
  for (const row of seoRows) {
    const pathAndQuery = str(row, "urlPathAndQuery");
    const url = pathAndQuery ? new URL(pathAndQuery, origin).toString() : "";
    if (url) pageByUrl.set(url, row);

    if (str(row, "title") === "") {
      findings.push({
        sourceEngine: "siteone-crawler",
        url,
        severity: "critical",
        category: "missing_title",
        title: "Page has no <title> element",
        description: "Search engines rely on the <title> element for the result snippet's headline; this page has none.",
        evidence: { urlPathAndQuery: pathAndQuery },
      });
    }
    if (str(row, "description") === "") {
      findings.push({
        sourceEngine: "siteone-crawler",
        url,
        severity: "low",
        category: "missing_meta_description",
        title: "Page has no meta description",
        description: "A meta description is optional but recommended — without one, search engines generate a snippet automatically, which is less controllable.",
        evidence: { urlPathAndQuery: pathAndQuery },
      });
    }
  }

  // --- duplicate titles/descriptions (ignore the degenerate "duplicate empty string" case — that's "missing", reported above) ---
  for (const row of tables["non-unique-titles"]?.rows ?? []) {
    const title = str(row, "title");
    if (!title) continue;
    const siblings = [...pageByUrl.entries()].filter(([, r]) => str(r, "title") === title).map(([u]) => u);
    for (const url of siblings) {
      findings.push({
        sourceEngine: "siteone-crawler",
        url,
        severity: "medium",
        category: "duplicate_title",
        title: `Title duplicated across ${siblings.length} pages`,
        description: `The title "${title}" is used on ${siblings.length} different pages, which can confuse search engines about which page to rank for related queries.`,
        evidence: { title, count: Number(str(row, "count")) || siblings.length, siblingUrls: siblings },
      });
    }
  }
  for (const row of tables["non-unique-descriptions"]?.rows ?? []) {
    const description = str(row, "description");
    if (!description) continue;
    const siblings = [...pageByUrl.entries()].filter(([, r]) => str(r, "description") === description).map(([u]) => u);
    for (const url of siblings) {
      findings.push({
        sourceEngine: "siteone-crawler",
        url,
        severity: "low",
        category: "duplicate_meta_description",
        title: `Meta description duplicated across ${siblings.length} pages`,
        description: `The same meta description is used on ${siblings.length} different pages.`,
        evidence: { description, count: Number(str(row, "count")) || siblings.length, siblingUrls: siblings },
      });
    }
  }

  // --- 404s (confirmed broken links) ---
  for (const row of tables["404"]?.rows ?? []) {
    findings.push({
      sourceEngine: "siteone-crawler",
      url: str(row, "url"),
      httpStatus: 404,
      severity: "high",
      category: "broken_link",
      title: "Broken link (404 Not Found)",
      description: `Linked from ${str(row, "sourceUqId")}, but returns 404.`,
      evidence: { sourceUqId: str(row, "sourceUqId") },
    });
  }

  // --- server errors (5xx) and timeouts, from the per-URL results list ---
  for (const r of results) {
    const status = str(r, "status");
    const url = str(r, "url");
    if (/^-2/.test(status) || /TIMEOUT/i.test(status)) {
      findings.push({
        sourceEngine: "siteone-crawler",
        url,
        severity: "high",
        category: "timeout",
        title: "Page did not respond within the request timeout",
        description: `The crawler's request to this page timed out (${status}).`,
        evidence: { status, elapsedTime: r.elapsedTime },
      });
    } else {
      const code = Number.parseInt(status, 10);
      if (!Number.isNaN(code) && code >= 500) {
        findings.push({
          sourceEngine: "siteone-crawler",
          url,
          httpStatus: code,
          severity: "critical",
          category: "server_error",
          title: `Server error (HTTP ${code})`,
          description: "This page returns a server error, which blocks indexing and breaks the user's visit.",
          evidence: { status },
        });
      }
    }
  }

  // --- redirects: reconstruct chains/loops, and flag any redirect target that is a private/reserved address (SSRF probe) ---
  const redirectRows = tables.redirects?.rows ?? [];
  const byUrl = new Map<string, { target: string; status: string; sourceUqId: string }>();
  for (const row of redirectRows) {
    byUrl.set(str(row, "url"), {
      target: str(row, "targetUrl"),
      status: str(row, "statusCode"),
      sourceUqId: str(row, "sourceUqId"),
    });
  }
  function resolveTarget(fromUrl: string, target: string): string {
    try {
      return new URL(target, fromUrl).toString();
    } catch {
      return target;
    }
  }

  const blockedSsrfRedirects: Array<{ fromUrl: string; targetUrl: string }> = [];
  const chainReported = new Set<string>();
  const startNodes = [...byUrl.keys()].filter((url) => {
    const entry = byUrl.get(url)!;
    // A chain "starts" at a redirect whose source wasn't itself one of our redirect URLs.
    return !byUrl.has(entry.sourceUqId);
  });

  for (const startUrl of startNodes) {
    if (chainReported.has(startUrl)) continue;
    const chain = [startUrl];
    const visitedInChain = new Set([startUrl]);
    let cursor = startUrl;
    let loop = false;
    for (let i = 0; i < 20; i++) {
      const entry = byUrl.get(cursor);
      if (!entry) break;
      const resolvedTarget = resolveTarget(cursor, entry.target);

      // SSRF check on every redirect target, literal-IP case (hostname case would need async DNS; literal IP covers our fixture and the classic cloud-metadata SSRF pattern).
      // Skip the check entirely for a target whose exact origin is explicitly allowlisted (test-only — see crawl-safety.ts), exactly like crawl-safety's own per-hop validation does.
      try {
        const targetUrlObj = new URL(resolvedTarget);
        const targetHost = targetUrlObj.hostname;
        const isAllowlisted = allowlistOrigins.includes(targetUrlObj.origin);
        if (!isAllowlisted && (/^\d+\.\d+\.\d+\.\d+$/.test(targetHost) || targetHost.includes(":"))) {
          if (isDisallowedIp(targetHost)) {
            blockedSsrfRedirects.push({ fromUrl: cursor, targetUrl: resolvedTarget });
          }
        }
      } catch {
        // malformed redirect target URL — ignore here, not a safety concern.
      }

      chain.push(resolvedTarget);
      if (visitedInChain.has(resolvedTarget)) {
        loop = true;
        break;
      }
      visitedInChain.add(resolvedTarget);
      if (!byUrl.has(resolvedTarget)) break; // chain ends (final destination wasn't itself a redirect)
      cursor = resolvedTarget;
    }
    for (const u of chain) chainReported.add(u);

    if (loop) {
      findings.push({
        sourceEngine: "siteone-crawler",
        url: startUrl,
        severity: "high",
        category: "redirect_loop",
        title: "Redirect loop detected",
        description: `Following redirects from ${startUrl} never reaches a final page: ${chain.join(" -> ")}.`,
        evidence: { chain },
      });
    } else if (chain.length - 1 >= 3) {
      findings.push({
        sourceEngine: "siteone-crawler",
        url: startUrl,
        severity: "medium",
        category: "redirect_chain",
        title: `Redirect chain of ${chain.length - 1} hops`,
        description: `This URL redirects through ${chain.length - 1} hops before reaching its final destination: ${chain.join(" -> ")}. Each hop adds latency; consider redirecting directly.`,
        evidence: { chain },
      });
    }
  }

  // --- skipped-by-robots (informational — proves robots.txt is respected, not reported as a defect) ---
  const skippedByRobots = (tables.skipped?.rows ?? [])
    .filter((row) => str(row, "reason").toLowerCase().includes("robots"))
    .map((row) => str(row, "url"));

  return { findings, discoveredUrls, skippedByRobots, blockedSsrfRedirects };
}

/** Fetch robots.txt once (reused for sitemap discovery AND the AI-crawler check below, instead of fetching it twice). Returns null if unreachable/non-2xx — the same "fall through" behavior as before. */
async function fetchRobotsTxt(origin: string, safety: CrawlSafetyOptions): Promise<string | null> {
  try {
    const result = await safeFetch(`${origin}/robots.txt`, safety);
    if (result.status >= 200 && result.status < 300) return result.body.toString("utf8");
  } catch {
    // treated as "no robots.txt" below
  }
  return null;
}

function discoverSitemapUrl(robotsTxt: string | null, origin: string): string {
  if (robotsTxt) {
    const match = robotsTxt.match(/^\s*Sitemap:\s*(\S+)/im);
    if (match) return match[1];
  }
  return `${origin}/sitemap.xml`;
}

/** llms.txt (https://llmstxt.org) presence check — a plain existence probe, nothing parsed. */
async function checkLlmsTxtExists(origin: string, safety: CrawlSafetyOptions): Promise<boolean> {
  try {
    const result = await safeFetch(`${origin}/llms.txt`, safety);
    return result.status >= 200 && result.status < 300;
  } catch {
    return false;
  }
}

export async function runCrawl(startUrl: string, options: CrawlOptions = {}): Promise<CrawlAdapterResult> {
  const safety: CrawlSafetyOptions = { allowlistOrigins: options.allowlistOrigins };

  // 1. SSRF / network-safety pre-flight on the user-supplied start URL.
  let validated;
  try {
    validated = await validateUrlForCrawl(startUrl, safety);
  } catch (err) {
    if (err instanceof CrawlSafetyError) {
      return {
        findings: [
          {
            sourceEngine: "crawler-adapter",
            url: startUrl,
            severity: "critical",
            category: "unsafe_crawl_target",
            title: "Crawl target blocked by network-safety pre-flight",
            description: `Refused to crawl "${startUrl}": ${err.message}`,
            evidence: { code: err.code },
          },
        ],
        meta: {
          startUrl,
          crawledPageCount: 0,
          skippedByRobots: [],
          blockedSsrfRedirects: [],
          sitemapUrlCount: 0,
          jsRenderingRequested: Boolean(options.jsRendering),
          jsRenderingUsed: false,
          exitCode: null,
          llmsTxtFound: false,
        },
      };
    }
    throw err;
  }

  const origin = validated.url.origin;
  const includeRegex = `^https?://${escapeRegex(validated.url.host)}(/|$)`;
  const binaryPath = resolveBinaryPath();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "crawl-"));
  const outJsonPath = path.join(outDir, "report.json");

  function buildArgs(useBrowser: boolean): string[] {
    return [
      `--url=${startUrl}`,
      "--output=json",
      `--output-json-file=${outJsonPath}`,
      "--output-html-report=",
      "--output-text-file=",
      `--timeout=${options.requestTimeoutSec ?? 5}`,
      `--max-depth=${options.maxDepth ?? 0}`,
      `--max-visited-urls=${options.maxPages ?? 500}`,
      "--workers=5",
      "--no-color",
      "--hide-progress-bar",
      "--no-cache",
      `--include-regex=${includeRegex}`,
      ...(useBrowser ? ["--browser"] : []),
    ];
  }

  let jsRenderingUsed = false;
  let jsRenderingUnavailableReason: string | undefined;
  let exitCode: number | null = 0;

  async function execute(useBrowser: boolean): Promise<void> {
    try {
      await execFileAsync(binaryPath, buildArgs(useBrowser), {
        timeout: options.processTimeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        signal: options.signal,
      });
      exitCode = 0;
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string; killed?: boolean; signal?: string };
      exitCode = typeof e.code === "number" ? e.code : null;
      if (e.killed || e.signal) {
        throw new Error(`siteone-crawler process timed out / was killed (signal=${e.signal})`);
      }
      // Non-zero exit is often still a usable report (e.g. a single page
      // timing out marks the whole run as an error) — the JSON file is
      // checked for below regardless of exit code.
      if (useBrowser && /no browser found/i.test(e.stderr ?? "")) {
        throw Object.assign(new Error("NO_BROWSER"), { noBrowser: true });
      }
    }
  }

  if (options.jsRendering) {
    try {
      await execute(true);
      jsRenderingUsed = true;
    } catch (err) {
      if ((err as { noBrowser?: boolean }).noBrowser) {
        jsRenderingUnavailableReason =
          "No Chromium-family browser is available in this environment (--browser-auto-download was not enabled). Fell back to static HTTP crawling.";
        await execute(false);
      } else {
        throw err;
      }
    }
  } else {
    await execute(false);
  }

  let report: SiteoneReport;
  try {
    const raw = await fs.readFile(outJsonPath, "utf8");
    report = JSON.parse(raw) as SiteoneReport;
  } finally {
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }

  const mapped = mapSiteoneReportToFindings(report, origin, options.allowlistOrigins ?? []);

  // 2. Supplementary rule-engine pass.
  const maxSupp = options.maxSupplementaryPages ?? 60;
  const pageUrls = [...mapped.discoveredUrls].slice(0, maxSupp);
  const snapshots = await fetchPageSnapshots(pageUrls, safety);

  const canonicalMap = new Map<string, string | null>();
  for (const snap of snapshots) {
    const match = snap.html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i);
    canonicalMap.set(snap.url, match ? new URL(match[1], snap.url).toString() : null);
  }

  const supplementaryFindings = [
    ...detectCanonicalConflicts(canonicalMap),
    ...detectHreflangIssues(snapshots),
    ...detectStructuredDataIssues(snapshots),
    ...detectMalformedHtml(snapshots),
  ];

  const robotsTxt = await fetchRobotsTxt(origin, safety);
  const sitemapUrl = discoverSitemapUrl(robotsTxt, origin);
  const sitemapUrls = await fetchSitemapUrls(sitemapUrl, safety);
  const orphanFindings = detectOrphanPages(sitemapUrls, mapped.discoveredUrls);

  // AI-crawler-visibility check (robots.txt already fetched above for
  // sitemap discovery; llms.txt is a cheap extra existence probe).
  const llmsTxtFound = await checkLlmsTxtExists(origin, safety);
  const aiVisibilityFindings = detectAiCrawlerAccessIssues(robotsTxt, llmsTxtFound);

  const allFindings = [...mapped.findings, ...supplementaryFindings, ...orphanFindings, ...aiVisibilityFindings];

  if (mapped.blockedSsrfRedirects.length > 0) {
    for (const blocked of mapped.blockedSsrfRedirects) {
      allFindings.push({
        sourceEngine: "crawler-adapter",
        url: blocked.fromUrl,
        severity: "critical",
        category: "ssrf_blocked_redirect",
        title: "Redirect to a private/reserved address was blocked",
        description: `This page redirects to ${blocked.targetUrl}, which resolves to a private/reserved network address. The crawl was scoped so this target was never fetched.`,
        evidence: { targetUrl: blocked.targetUrl },
      });
    }
  }

  return {
    findings: allFindings,
    meta: {
      startUrl,
      crawledPageCount: mapped.discoveredUrls.size,
      skippedByRobots: mapped.skippedByRobots,
      blockedSsrfRedirects: mapped.blockedSsrfRedirects,
      sitemapUrlCount: sitemapUrls.length,
      jsRenderingRequested: Boolean(options.jsRendering),
      jsRenderingUsed,
      jsRenderingUnavailableReason,
      exitCode,
      binaryVersion: report.crawler?.version,
      llmsTxtFound,
    },
  };
}
