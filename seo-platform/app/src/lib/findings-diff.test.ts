import { describe, it, expect } from "vitest";
import { diffFindings, findingKey, isMediumOrHigher } from "./findings-diff";
import type { FindingRow } from "./findings-diff";

function makeFinding(overrides: Partial<FindingRow>): FindingRow {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    crawlJobId: overrides.crawlJobId ?? "job-1",
    websiteId: overrides.websiteId ?? "site-1",
    sourceEngine: overrides.sourceEngine ?? "siteone-crawler",
    url: overrides.url ?? "https://example.com/",
    canonicalUrl: overrides.canonicalUrl ?? null,
    httpStatus: overrides.httpStatus ?? null,
    severity: overrides.severity ?? "high",
    category: overrides.category ?? "broken_link",
    title: overrides.title ?? "A finding",
    description: overrides.description ?? "",
    evidence: overrides.evidence ?? {},
    discoveredAt: overrides.discoveredAt ?? new Date(),
  };
}

describe("findingKey", () => {
  it("is stable across different crawl/finding ids for the same category+url", () => {
    const a = makeFinding({ id: "a", crawlJobId: "job-1", category: "missing_title", url: "https://x/p" });
    const b = makeFinding({ id: "b", crawlJobId: "job-2", category: "missing_title", url: "https://x/p" });
    expect(findingKey(a)).toBe(findingKey(b));
  });

  it("differs for a different category on the same url", () => {
    const a = makeFinding({ category: "missing_title", url: "https://x/p" });
    const b = makeFinding({ category: "broken_link", url: "https://x/p" });
    expect(findingKey(a)).not.toBe(findingKey(b));
  });

  it("differs for the same category on a different url", () => {
    const a = makeFinding({ category: "missing_title", url: "https://x/p" });
    const b = makeFinding({ category: "missing_title", url: "https://x/q" });
    expect(findingKey(a)).not.toBe(findingKey(b));
  });
});

describe("diffFindings", () => {
  it("classifies new / resolved / persisting correctly by category+url, not by id", () => {
    const previous: FindingRow[] = [
      makeFinding({ id: "p1", category: "missing_title", url: "https://x/stable" }), // persists
      makeFinding({ id: "p2", category: "broken_link", url: "https://x/fixed-later" }), // resolved
    ];
    const current: FindingRow[] = [
      // Same logical issue as p1, but a brand-new id (as every real crawl produces).
      makeFinding({ id: "c1", category: "missing_title", url: "https://x/stable" }),
      makeFinding({ id: "c2", category: "missing_meta_description", url: "https://x/new-issue" }), // new
    ];

    const diff = diffFindings(previous, current);

    expect(diff.persistingFindings.map((f) => f.id)).toEqual(["c1"]);
    expect(diff.newFindings.map((f) => f.id)).toEqual(["c2"]);
    expect(diff.resolvedFindings.map((f) => f.id)).toEqual(["p2"]);
  });

  it("returns everything as new when there is no previous crawl data", () => {
    const current = [makeFinding({ id: "c1" })];
    const diff = diffFindings([], current);
    expect(diff.newFindings).toHaveLength(1);
    expect(diff.resolvedFindings).toHaveLength(0);
    expect(diff.persistingFindings).toHaveLength(0);
  });

  it("returns everything as resolved when the current crawl has no findings at all", () => {
    const previous = [makeFinding({ id: "p1" })];
    const diff = diffFindings(previous, []);
    expect(diff.resolvedFindings).toHaveLength(1);
    expect(diff.newFindings).toHaveLength(0);
    expect(diff.persistingFindings).toHaveLength(0);
  });
});

describe("isMediumOrHigher", () => {
  it("treats critical/high/medium as meaningful and low as not", () => {
    expect(isMediumOrHigher("critical")).toBe(true);
    expect(isMediumOrHigher("high")).toBe(true);
    expect(isMediumOrHigher("medium")).toBe(true);
    expect(isMediumOrHigher("low")).toBe(false);
  });
});
