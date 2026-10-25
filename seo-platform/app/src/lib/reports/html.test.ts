/**
 * Phase 7 security regression: the HTML report renders untrusted
 * content — crawled page titles/descriptions and AI-generated
 * recommendation text — directly into an HTML document returned to the
 * browser (both as a standalone downloaded report and, via the same
 * `generateHtml`, inline content). None of that text is sanitized or
 * safe HTML; `generateHtml` must escape every one of these fields
 * (finding title/description/url/category, recommendation title/body,
 * website URL, organization name, history sample titles/urls) so a
 * crawled page or a model response cannot inject executable markup
 * into the rendered report.
 *
 * This test builds a `ReportPayload` by hand (no DB/crawl needed) with
 * a classic `<script>alert(1)</script>` payload in every user/AI
 * controlled string field and asserts the literal, unescaped string
 * never appears in the output — only its HTML-escaped form does.
 */
import { describe, it, expect } from "vitest";
import { generateHtml } from "./html";
import type { ReportPayload } from "./report-data";

const XSS = `<script>alert(1)</script>`;
const XSS_ESCAPED = `&lt;script&gt;alert(1)&lt;/script&gt;`;

function buildPayload(overrides: Partial<ReportPayload> = {}): ReportPayload {
  const base: ReportPayload = {
    meta: {
      websiteId: "11111111-1111-1111-1111-111111111111",
      websiteUrl: `https://example.com/${XSS}`,
      organizationName: XSS,
      crawlJobId: "22222222-2222-2222-2222-222222222222",
      crawlStartedAt: "2026-01-01T00:00:00.000Z",
      crawlFinishedAt: "2026-01-01T00:05:00.000Z",
      generatedAt: "2026-01-01T00:06:00.000Z",
    },
    healthScore: {
      score: 80,
      rawScore: 80,
      totalFindings: 1,
      deductionBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      formula: "100 minus deductions",
    },
    categoryScores: [
      { category: "technical", label: "Technical", score: 80, rawScore: 80, totalFindings: 1, deductionBySeverity: {}, formula: "f" },
      { category: "on_page", label: "On-Page", score: 100, rawScore: 100, totalFindings: 0, deductionBySeverity: {}, formula: "f" },
      { category: "content", label: "Content", score: 100, rawScore: 100, totalFindings: 0, deductionBySeverity: {}, formula: "f" },
      { category: "ai_visibility", label: "AI Visibility", score: 100, rawScore: 100, totalFindings: 0, deductionBySeverity: {}, formula: "f" },
    ],
    summary: {
      totalFindings: 1,
      bySeverity: { critical: 1 },
      byCategory: { technical: 1 },
      affectedUrlCount: 1,
    },
    findings: [
      {
        id: "33333333-3333-3333-3333-333333333333",
        sourceEngine: "siteone",
        url: `https://example.com/${XSS}`,
        canonicalUrl: null,
        httpStatus: 200,
        severity: "critical",
        // Attacker-controlled: a page's real <title> tag can contain
        // arbitrary markup; this is exactly the kind of string a real
        // crawl would capture verbatim into `findings.title`.
        category: XSS,
        title: XSS,
        description: XSS,
        discoveredAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    recommendations: [
      {
        id: "44444444-4444-4444-4444-444444444444",
        kind: "audit_summary",
        findingIds: [],
        priority: null,
        // Attacker-controlled: AI-generated text is untrusted model
        // output and must be escaped the same as crawled content.
        title: XSS,
        body: XSS,
        generatedBy: "ollama",
      },
      {
        id: "55555555-5555-5555-5555-555555555555",
        kind: "dev_task",
        findingIds: [],
        priority: "high",
        title: XSS,
        body: XSS,
        generatedBy: "ollama",
      },
      {
        id: "66666666-6666-6666-6666-666666666666",
        kind: "finding_explanation",
        findingIds: [],
        priority: null,
        title: XSS,
        body: XSS,
        generatedBy: "ollama",
      },
    ],
    aiAssisted: true,
    history: {
      previousCrawlJobId: XSS,
      currentCrawlJobId: XSS,
      newCount: 1,
      resolvedCount: 0,
      persistingCount: 0,
      newSample: [{ category: XSS, severity: "critical", url: `https://example.com/${XSS}`, title: XSS }],
      resolvedSample: [],
    },
  };
  return { ...base, ...overrides };
}

describe("generateHtml — untrusted content is always HTML-escaped", () => {
  it("never emits a literal <script> tag from crawled/AI-generated content", () => {
    const html = generateHtml(buildPayload());

    // The raw, unescaped payload must never appear anywhere in the output.
    expect(html).not.toContain(XSS);
    expect(html.toLowerCase()).not.toContain("<script>alert(1)</script>");

    // The escaped form must appear instead — proving the content was
    // actually rendered (not silently dropped), just safely.
    expect(html).toContain(XSS_ESCAPED);
  });

  it("escapes the website URL, org name, finding fields, recommendations, and history section", () => {
    const html = generateHtml(buildPayload());
    // Count occurrences: website URL + org name + finding title/description/category/url
    // + 3 recommendation title/body pairs + history sample title/url all
    // contain the same payload, so the escaped marker should appear many
    // times and the raw marker zero times.
    const rawOccurrences = html.split(XSS).length - 1;
    const escapedOccurrences = html.split(XSS_ESCAPED).length - 1;
    expect(rawOccurrences).toBe(0);
    expect(escapedOccurrences).toBeGreaterThan(5);
  });

  it("still renders a clean report with no history section without throwing", () => {
    const html = generateHtml(buildPayload({ history: null, findings: [], recommendations: [] }));
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("07. Historical Comparison");
  });
});
