import { describe, it, expect } from "vitest";
import { computeCategoryScores, mapFindingCategory, CATEGORY_ORDER } from "./category-scores";
import { SEVERITY_DEDUCTIONS } from "./health-score";

describe("computeCategoryScores", () => {
  it("returns all four categories, each scoring a clean 100, when there are no findings at all", () => {
    const scores = computeCategoryScores([]);
    expect(scores.map((s) => s.category).sort()).toEqual([...CATEGORY_ORDER].sort());
    for (const s of scores) {
      expect(s.score).toBe(100);
      expect(s.totalFindings).toBe(0);
    }
  });

  it("a category with zero RELEVANT findings (others exist) still scores a clean 100, not omitted", () => {
    const findings = [{ category: "broken_link", severity: "critical" }]; // technical only
    const scores = computeCategoryScores(findings);
    const onPage = scores.find((s) => s.category === "on_page")!;
    const content = scores.find((s) => s.category === "content")!;
    const aiVisibility = scores.find((s) => s.category === "ai_visibility")!;
    expect(onPage.score).toBe(100);
    expect(content.score).toBe(100);
    expect(aiVisibility.score).toBe(100);
  });

  it("hand-checked math: deducts only within the matching category, using the exact documented per-severity amounts", () => {
    const findings = [
      { category: "broken_link", severity: "critical" }, // technical: -8
      { category: "server_error", severity: "high" }, // technical: -4
      { category: "missing_title", severity: "critical" }, // on_page: -8
      { category: "orphan_page", severity: "low" }, // content: -0.5
      { category: "ai_crawler_blocked", severity: "medium" }, // ai_visibility: -2
      { category: "ai_crawler_blocked", severity: "medium" }, // ai_visibility: -2 (second, distinct bot)
    ];
    const scores = computeCategoryScores(findings);
    const byCat = Object.fromEntries(scores.map((s) => [s.category, s]));

    expect(byCat.technical.rawScore).toBeCloseTo(100 - SEVERITY_DEDUCTIONS.critical - SEVERITY_DEDUCTIONS.high, 5);
    expect(byCat.technical.totalFindings).toBe(2);

    expect(byCat.on_page.rawScore).toBeCloseTo(100 - SEVERITY_DEDUCTIONS.critical, 5);
    expect(byCat.on_page.totalFindings).toBe(1);

    expect(byCat.content.rawScore).toBeCloseTo(100 - SEVERITY_DEDUCTIONS.low, 5);
    expect(byCat.content.totalFindings).toBe(1);

    expect(byCat.ai_visibility.rawScore).toBeCloseTo(100 - 2 * SEVERITY_DEDUCTIONS.medium, 5);
    expect(byCat.ai_visibility.totalFindings).toBe(2);
  });

  it("maps every known AI-visibility category correctly", () => {
    expect(mapFindingCategory("ai_crawler_blocked")).toBe("ai_visibility");
    expect(mapFindingCategory("llms_txt_missing")).toBe("ai_visibility");
  });

  it("falls back an unmapped/future category to a bucket rather than crashing or dropping it", () => {
    const scores = computeCategoryScores([{ category: "some_brand_new_check_nobody_mapped_yet", severity: "high" }]);
    const totalAcrossCategories = scores.reduce((sum, s) => sum + s.totalFindings, 0);
    expect(totalAcrossCategories).toBe(1); // counted exactly once, somewhere — never silently dropped
  });
});
