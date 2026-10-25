/**
 * Category score breakdown — report-polish pass.
 *
 * Applies the EXACT SAME deterministic deduction formula as the overall
 * health score (health-score.ts's `computeHealthScore`), just scoped to
 * each category bucket's own findings. This is deliberately not a
 * second formula — it's the same one, run four times on four subsets of
 * the same real `findings` rows, so there is nothing new to audit
 * beyond "is the mapping below correct."
 *
 * CATEGORY_MAP is the single source of truth for which finding
 * `category` string (from crawler-adapter.ts's siteone-crawler mapping
 * and supplementary-rules.ts's own checks — see those files for the
 * authoritative list) belongs to which of the four report buckets.
 * docs/AI_AND_SCORING.md mirrors this table in prose; if you add a new
 * finding category anywhere in the crawl pipeline, add it here too (and
 * update that doc) in the SAME change, same convention as
 * SEVERITY_DEDUCTIONS in health-score.ts.
 */
import { computeHealthScore, type HealthScoreInput, type HealthScoreResult } from "./health-score";

export type ReportCategory = "technical" | "on_page" | "content" | "ai_visibility";

export const CATEGORY_LABELS: Record<ReportCategory, string> = {
  technical: "Technical",
  on_page: "On-Page",
  content: "Content",
  ai_visibility: "AI Visibility",
};

/** Display order used consistently across HTML, PDF, and JSON. */
export const CATEGORY_ORDER: ReportCategory[] = ["technical", "on_page", "content", "ai_visibility"];

/**
 * The mapping. Every key here is a REAL finding `category` string this
 * codebase actually produces today (verified against crawler-adapter.ts
 * and supplementary-rules.ts — not guessed):
 *
 *   Technical   — status codes, redirects, robots/sitemap/SSRF targets,
 *                  timeouts, malformed HTML:
 *                  broken_link, timeout, server_error, redirect_loop,
 *                  redirect_chain, unsafe_crawl_target,
 *                  ssrf_blocked_redirect, malformed_html,
 *                  structured_data_invalid (invalid JSON-LD markup is a
 *                  markup/technical defect, not an on-page copy issue)
 *
 *   On-Page     — titles, meta descriptions, canonical, hreflang:
 *                  missing_title, missing_meta_description,
 *                  duplicate_title, duplicate_meta_description,
 *                  canonical_conflict, hreflang_not_reciprocal
 *                  (NOTE: this codebase does not yet check headings or
 *                  image alt text — see docs/AI_AND_SCORING.md; nothing
 *                  is listed here for either because nothing is
 *                  detected for either, by design — no placeholder
 *                  categories that would never fire)
 *
 *   Content     — orphan pages (the only content-category check this
 *                  codebase currently runs; duplicate/thin content
 *                  detection does not exist yet, so nothing is mapped
 *                  for it — see docs/AI_AND_SCORING.md):
 *                  orphan_page, orphan_page_summary
 *
 *   AI Visibility — this phase's new check (supplementary-rules.ts's
 *                  detectAiCrawlerAccessIssues):
 *                  ai_crawler_blocked, llms_txt_missing
 */
export const CATEGORY_MAP: Record<string, ReportCategory> = {
  // Technical
  broken_link: "technical",
  timeout: "technical",
  server_error: "technical",
  redirect_loop: "technical",
  redirect_chain: "technical",
  unsafe_crawl_target: "technical",
  ssrf_blocked_redirect: "technical",
  malformed_html: "technical",
  structured_data_invalid: "technical",

  // On-Page
  missing_title: "on_page",
  missing_meta_description: "on_page",
  duplicate_title: "on_page",
  duplicate_meta_description: "on_page",
  canonical_conflict: "on_page",
  hreflang_not_reciprocal: "on_page",

  // Content
  orphan_page: "content",
  orphan_page_summary: "content",

  // AI Visibility
  ai_crawler_blocked: "ai_visibility",
  llms_txt_missing: "ai_visibility",
};

/**
 * Conservative default for any finding category NOT in the map above
 * (e.g. a new check added to the crawl pipeline without updating this
 * file yet). "technical" was chosen because every category added here
 * historically (broken links, timeouts, server errors, malformed
 * markup) has been a technical/structural defect, not an on-page
 * copywriting or content issue — an unmapped finding is far more likely
 * to be a forgotten technical check than a forgotten on-page one. This
 * default exists so a newly added, not-yet-mapped check is never
 * silently dropped from every category score (it still counts against
 * one category); it is not a substitute for updating CATEGORY_MAP and
 * docs/AI_AND_SCORING.md in the same change that adds a new category.
 */
const UNMAPPED_CATEGORY_DEFAULT: ReportCategory = "technical";

export function mapFindingCategory(findingCategory: string): ReportCategory {
  return CATEGORY_MAP[findingCategory] ?? UNMAPPED_CATEGORY_DEFAULT;
}

export interface CategoryScore extends HealthScoreResult {
  category: ReportCategory;
  label: string;
}

/**
 * Computes all four category scores from one flat findings list. A
 * category with zero relevant findings scores a clean 100 (via
 * `computeHealthScore([])`), never omitted and never an error — per
 * spec, a category that has nothing wrong IS the correct report of
 * "nothing wrong," not a gap in the report.
 */
export function computeCategoryScores<T extends HealthScoreInput & { category: string }>(
  findings: T[]
): CategoryScore[] {
  const byCategory = new Map<ReportCategory, HealthScoreInput[]>();
  for (const cat of CATEGORY_ORDER) byCategory.set(cat, []);

  for (const f of findings) {
    const bucket = mapFindingCategory(f.category);
    byCategory.get(bucket)!.push(f);
  }

  return CATEGORY_ORDER.map((category) => {
    const result = computeHealthScore(byCategory.get(category) ?? []);
    return { ...result, category, label: CATEGORY_LABELS[category] };
  });
}
