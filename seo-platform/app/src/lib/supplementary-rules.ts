/**
 * Supplementary rule-engine pass (sourceEngine="supplementary-rules").
 *
 * siteone-crawler's JSON report gives us page-level title/meta
 * description/H1/robots data and site-wide redirect/404/duplicate
 * tables, but its JSON output does NOT expose: per-page canonical
 * target, hreflang alternates, or raw HTML (needed for JSON-LD presence
 * /validity and malformed-HTML detection) — verified by inspecting its
 * actual `--output=json` output against the fixture site (see
 * docs/INTEGRATION_ARCHITECTURE.md). This module fills exactly those
 * gaps, and only those: it does not re-implement anything siteone-crawler
 * already reports (duplicate titles/descriptions, broken links, missing
 * title, redirects, robots.txt handling, 5xx/timeouts).
 *
 * It fetches each already-discovered page's raw HTML itself, through
 * `safeFetch` (same SSRF pre-flight, same allowlist, applied per request
 * and per redirect hop — never a second, unprotected code path).
 */
import { safeFetch, type CrawlSafetyOptions } from "./crawl-safety";
import type { NormalizedFinding } from "./finding-types";

/**
 * Well-known AI-crawler user-agent tokens, as publicly documented by
 * each vendor (checked against each vendor's own robots.txt
 * documentation at the time this was written — not guessed):
 *  - GPTBot, ChatGPT-User: OpenAI (https://platform.openai.com/docs/gptbot)
 *  - ClaudeBot, anthropic-ai: Anthropic
 *  - PerplexityBot: Perplexity AI
 *  - Google-Extended: Google's opt-out token for Gemini/Vertex AI
 *    training (sent as part of Googlebot's normal fetches, but
 *    controlled via this separate robots.txt token)
 *  - CCBot: Common Crawl (widely used as LLM pretraining data by many
 *    labs, not just one)
 *  - Bytespider: ByteDance
 *  - Applebot-Extended: Apple's opt-out token for Apple Intelligence
 *    training
 * This list reflects the vendors' documented tokens as of this writing
 * and should be revisited periodically — new AI crawlers appear
 * regularly. Never invent a token that isn't actually documented by its
 * vendor.
 */
export const KNOWN_AI_CRAWLER_USER_AGENTS: Array<{ userAgent: string; vendor: string }> = [
  { userAgent: "GPTBot", vendor: "OpenAI" },
  { userAgent: "ChatGPT-User", vendor: "OpenAI" },
  { userAgent: "ClaudeBot", vendor: "Anthropic" },
  { userAgent: "anthropic-ai", vendor: "Anthropic" },
  { userAgent: "PerplexityBot", vendor: "Perplexity AI" },
  { userAgent: "Google-Extended", vendor: "Google (Gemini / Vertex AI training opt-out token)" },
  { userAgent: "CCBot", vendor: "Common Crawl (reused as training data by many AI labs)" },
  { userAgent: "Bytespider", vendor: "ByteDance" },
  { userAgent: "Applebot-Extended", vendor: "Apple (Apple Intelligence training opt-out token)" },
];

interface RobotsGroup {
  userAgents: string[];
  disallows: string[];
  allows: string[];
}

/**
 * Minimal robots.txt parser: groups consecutive `User-agent:` lines
 * into one group (standard robots.txt grouping — a blank-line or a new
 * `User-agent:` line appearing AFTER at least one rule line starts a
 * new group), collecting that group's `Disallow`/`Allow` rules. Good
 * enough for the one thing we need it for (detecting a full-site block
 * of a specific named bot) — this is not a general-purpose robots.txt
 * rule-precedence engine.
 */
function parseRobotsGroups(robotsTxt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let sawRuleSinceLastUserAgent = false;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (key === "user-agent") {
      if (current && sawRuleSinceLastUserAgent) current = null;
      if (!current) {
        current = { userAgents: [], disallows: [], allows: [] };
        groups.push(current);
        sawRuleSinceLastUserAgent = false;
      }
      current.userAgents.push(value);
    } else if (key === "disallow" && current) {
      current.disallows.push(value);
      sawRuleSinceLastUserAgent = true;
    } else if (key === "allow" && current) {
      current.allows.push(value);
      sawRuleSinceLastUserAgent = true;
    }
  }
  return groups;
}

/** True if a robots.txt group targeting exactly this bot (case-insensitive) fully disallows the whole site ("Disallow: /" or "/*", not overridden by an "Allow: /"). */
function isFullyBlockedForBot(groups: RobotsGroup[], userAgent: string): boolean {
  const target = userAgent.toLowerCase();
  for (const group of groups) {
    if (!group.userAgents.some((ua) => ua.toLowerCase() === target)) continue;
    const blocksRoot = group.disallows.some((d) => d === "/" || d === "/*");
    if (!blocksRoot) continue;
    const allowsRoot = group.allows.some((a) => a === "/" || a === "");
    if (!allowsRoot) return true;
  }
  return false;
}

/**
 * AI-crawler-visibility check (real feature gap, not just a design
 * change — see docs/DESIGN_UPDATES.md's "Competitive reference" #5).
 * Produces ONE finding per blocked well-known AI bot (never a combined
 * finding) so a report can show exactly which bots are blocked, plus
 * one low-severity informational finding when no `llms.txt` is found
 * (its absence is common and not itself a defect — see
 * https://llmstxt.org for the convention this checks for).
 */
export function detectAiCrawlerAccessIssues(
  robotsTxt: string | null,
  llmsTxtFound: boolean
): NormalizedFinding[] {
  const findings: NormalizedFinding[] = [];
  const groups = robotsTxt ? parseRobotsGroups(robotsTxt) : [];

  for (const bot of KNOWN_AI_CRAWLER_USER_AGENTS) {
    if (isFullyBlockedForBot(groups, bot.userAgent)) {
      findings.push({
        sourceEngine: "supplementary-rules",
        url: "/robots.txt",
        severity: "medium",
        category: "ai_crawler_blocked",
        title: `robots.txt blocks ${bot.userAgent} (${bot.vendor})`,
        description: `robots.txt has a "User-agent: ${bot.userAgent}" group with "Disallow: /", fully blocking ${bot.vendor}'s AI crawler from the entire site. If being referenced or cited by AI assistants/answer engines matters for this business, this is worth a deliberate decision rather than an unreviewed default.`,
        evidence: { userAgent: bot.userAgent, vendor: bot.vendor },
      });
    }
  }

  if (!llmsTxtFound) {
    findings.push({
      sourceEngine: "supplementary-rules",
      url: "/llms.txt",
      severity: "low",
      category: "llms_txt_missing",
      title: "No llms.txt file found",
      description: "llms.txt (see https://llmstxt.org) is an emerging, voluntary convention for giving AI assistants a curated Markdown summary of a site's key content. Its absence is informational, not an error — most sites, including many well-optimized ones, don't have one yet.",
      evidence: { checkedPath: "/llms.txt" },
    });
  }

  return findings;
}

const HREFLANG_RE =
  /<link[^>]+rel=["']alternate["'][^>]*hreflang=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
const JSONLD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const SITEMAP_LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

export interface PageSnapshot {
  url: string;
  html: string;
}

/** Fetch a bounded set of already-discovered pages' raw HTML for analysis. */
export async function fetchPageSnapshots(
  urls: string[],
  safety: CrawlSafetyOptions
): Promise<PageSnapshot[]> {
  const snapshots: PageSnapshot[] = [];
  for (const url of urls) {
    try {
      const result = await safeFetch(url, safety);
      if (result.status >= 200 && result.status < 300) {
        snapshots.push({ url, html: result.body.toString("utf8") });
      }
    } catch {
      // Already reported elsewhere (broken link / blocked / timeout) by
      // the main crawl; the supplementary pass just skips pages it
      // cannot safely fetch itself.
    }
  }
  return snapshots;
}

/** Fetch and parse a sitemap.xml, returning its listed <loc> URLs. */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  safety: CrawlSafetyOptions
): Promise<string[]> {
  try {
    const result = await safeFetch(sitemapUrl, safety);
    if (result.status < 200 || result.status >= 300) return [];
    const xml = result.body.toString("utf8");
    const urls: string[] = [];
    for (const match of xml.matchAll(SITEMAP_LOC_RE)) {
      urls.push(match[1]);
    }
    return urls;
  } catch {
    return [];
  }
}

/**
 * Canonical-conflict detection: build the canonical chain for every page
 * that declares a <link rel="canonical"> pointing at a DIFFERENT URL,
 * and flag any chain that does not converge on a single stable target
 * (A -> B -> C -> ... never landing on a page that canonicalizes to
 * itself or has no canonical at all).
 */
export function detectCanonicalConflicts(
  pages: Map<string, string | null>
): NormalizedFinding[] {
  const findings: NormalizedFinding[] = [];
  const reported = new Set<string>();

  for (const [url, canonical] of pages) {
    if (!canonical || canonical === url || reported.has(url)) continue;

    const chain = [url];
    const visited = new Set([url]);
    let current = canonical;
    let converged = false;
    let loop = false;

    for (let i = 0; i < 10; i++) {
      chain.push(current);
      if (visited.has(current)) {
        loop = true;
        break;
      }
      visited.add(current);
      const next = pages.get(current);
      if (next === undefined || next === null || next === current) {
        converged = next === current; // self-canonical = stable landing
        break;
      }
      current = next;
    }

    if (!converged || loop) {
      for (const u of chain) reported.add(u);
      findings.push({
        sourceEngine: "supplementary-rules",
        url,
        canonicalUrl: canonical,
        severity: "high",
        category: "canonical_conflict",
        title: "Canonical tag chain does not resolve to a stable URL",
        description: loop
          ? `Canonical tags form a loop across ${chain.length - 1} pages (${chain.join(" -> ")}), so no single canonical URL is ever reached.`
          : `Canonical tags chain across multiple pages (${chain.join(" -> ")}) without ever landing on a page that canonicalizes to itself.`,
        evidence: { chain, loop },
      });
    }
  }
  return findings;
}

/**
 * Orphan pages: listed in sitemap.xml but never discovered via internal
 * links during the crawl. Capped to `sampleLimit` individual findings
 * (plus one rollup finding noting the true total) so a site with a huge,
 * mostly-unlinked sitemap doesn't flood the findings table.
 */
export function detectOrphanPages(
  sitemapUrls: string[],
  discoveredUrls: Set<string>,
  sampleLimit = 25
): NormalizedFinding[] {
  const orphans = sitemapUrls.filter((u) => !discoveredUrls.has(u));
  const sample = orphans.slice(0, sampleLimit);
  const findings: NormalizedFinding[] = sample.map((url) => ({
    sourceEngine: "supplementary-rules" as const,
    url,
    severity: "low" as const,
    category: "orphan_page",
    title: "Page listed in sitemap.xml but not linked from any crawled page",
    description:
      "This URL is listed in the sitemap but was not reached by following internal links during the crawl, so users and crawlers relying on link discovery alone may never find it.",
    evidence: { foundVia: "sitemap.xml", linkedInternally: false },
  }));
  if (orphans.length > sampleLimit) {
    findings.push({
      sourceEngine: "supplementary-rules",
      url: sitemapUrls[0] ?? "",
      severity: "low",
      category: "orphan_page_summary",
      title: `${orphans.length} total orphan pages found (showing ${sampleLimit})`,
      description: `The sitemap lists ${orphans.length} URLs that were never reached via internal links; only the first ${sampleLimit} are reported individually.`,
      evidence: { totalOrphanCount: orphans.length, sampleCount: sampleLimit },
    });
  }
  return findings;
}

/** hreflang reciprocity: an alternate link whose target does not link back. */
export function detectHreflangIssues(pages: PageSnapshot[]): NormalizedFinding[] {
  const findings: NormalizedFinding[] = [];
  const hreflangByPage = new Map<string, Array<{ lang: string; href: string }>>();

  for (const page of pages) {
    const alts: Array<{ lang: string; href: string }> = [];
    for (const match of page.html.matchAll(HREFLANG_RE)) {
      alts.push({ lang: match[1], href: match[2] });
    }
    if (alts.length > 0) hreflangByPage.set(page.url, alts);
  }

  for (const [url, alts] of hreflangByPage) {
    for (const alt of alts) {
      if (alt.href === url) continue; // self-reference, fine
      const targetAlts = hreflangByPage.get(alt.href);
      const reciprocates = targetAlts?.some((a) => a.href === url);
      if (!reciprocates) {
        findings.push({
          sourceEngine: "supplementary-rules",
          url,
          severity: "medium",
          category: "hreflang_not_reciprocal",
          title: `hreflang alternate (${alt.lang}) does not link back`,
          description: `${url} declares hreflang="${alt.lang}" pointing to ${alt.href}, but that page does not declare a reciprocal hreflang back to ${url}. Search engines may ignore non-reciprocal hreflang annotations.`,
          evidence: { declaredAlternate: alt, targetFetchable: targetAlts !== undefined },
        });
      }
    }
  }
  return findings;
}

/** JSON-LD structured data presence/validity. Only reports invalid blocks (not absence — that's optional). */
export function detectStructuredDataIssues(pages: PageSnapshot[]): NormalizedFinding[] {
  const findings: NormalizedFinding[] = [];
  for (const page of pages) {
    for (const match of page.html.matchAll(JSONLD_RE)) {
      const raw = match[1].trim();
      try {
        JSON.parse(raw);
      } catch (err) {
        findings.push({
          sourceEngine: "supplementary-rules",
          url: page.url,
          severity: "medium",
          category: "structured_data_invalid",
          title: "Invalid JSON-LD structured data",
          description: `A <script type="application/ld+json"> block on this page is not valid JSON and will be ignored by search engines: ${(err as Error).message}`,
          evidence: { snippet: raw.slice(0, 300) },
        });
      }
    }
  }
  return findings;
}

/**
 * Malformed HTML: a simple, auditable structural heuristic — mismatched
 * open/close counts for common block tags. Not a full HTML validator;
 * flags the specific, common defect of unclosed block-level elements.
 */
export function detectMalformedHtml(pages: PageSnapshot[]): NormalizedFinding[] {
  const findings: NormalizedFinding[] = [];
  const tags = ["div", "span", "p", "h1"];
  for (const page of pages) {
    const mismatches: Record<string, { open: number; close: number }> = {};
    let hasMismatch = false;
    for (const tag of tags) {
      const openCount = (page.html.match(new RegExp(`<${tag}(\\s[^>]*)?>`, "gi")) || []).length;
      const closeCount = (page.html.match(new RegExp(`</${tag}>`, "gi")) || []).length;
      if (openCount !== closeCount) {
        hasMismatch = true;
        mismatches[tag] = { open: openCount, close: closeCount };
      }
    }
    const hasClosingHtml = /<\/html>/i.test(page.html);
    if (hasMismatch || !hasClosingHtml) {
      findings.push({
        sourceEngine: "supplementary-rules",
        url: page.url,
        severity: "medium",
        category: "malformed_html",
        title: "Malformed/unclosed HTML markup detected",
        description: "Mismatched opening/closing tags (or a missing closing </html>) were detected — browsers will apply error-correction heuristics, but this can cause unpredictable rendering and layout.",
        evidence: { tagMismatches: mismatches, missingClosingHtml: !hasClosingHtml },
      });
    }
  }
  return findings;
}
