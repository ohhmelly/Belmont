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
