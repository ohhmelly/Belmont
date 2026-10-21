/**
 * Health score — Phase 4.
 *
 * DOCUMENTED, DETERMINISTIC, AUDITABLE FORMULA (mirrored in
 * docs/REPORTING.md — if you change the constants below, update that
 * doc too):
 *
 *   score = 100
 *   for each finding:
 *     score -= SEVERITY_DEDUCTIONS[finding.severity]
 *   score = clamp(score, 0, 100)
 *
 * Deductions per finding (NOT per category — two findings of the same
 * category on different pages each deduct separately, because each is
 * a distinct discovered problem instance a visitor/crawler can hit):
 *
 *   critical: 8 points
 *   high:     4 points
 *   medium:   2 points
 *   low:      0.5 points
 *
 * A crawl with zero findings scores 100. There is no floor above 0 and
 * no ceiling above 100 — a site with enough critical findings legitimately
 * bottoms out at 0.
 *
 * This is a simple weighted-deduction model over data we actually
 * measured (the findings table). It is explicitly NOT a statistical or
 * ML-derived score, is NOT calibrated against real search-ranking
 * outcomes, and must never be presented as predicting or guaranteeing
 * any ranking/traffic result — it only measures how many, and how
 * severe, the technical issues this audit actually found are.
 */
export const SEVERITY_DEDUCTIONS: Record<string, number> = {
  critical: 8,
  high: 4,
  medium: 2,
  low: 0.5,
};

const UNKNOWN_SEVERITY_DEDUCTION = 1;

export interface HealthScoreInput {
  severity: string;
}

export interface HealthScoreResult {
  /** 0-100, rounded to the nearest integer for display. */
  score: number;
  /** Unrounded value, kept for the JSON report / auditing. */
  rawScore: number;
  totalFindings: number;
  deductionBySeverity: Record<string, number>;
  formula: string;
}

export function computeHealthScore(findings: HealthScoreInput[]): HealthScoreResult {
  let raw = 100;
  const deductionBySeverity: Record<string, number> = {};
  for (const f of findings) {
    const deduction = SEVERITY_DEDUCTIONS[f.severity] ?? UNKNOWN_SEVERITY_DEDUCTION;
    raw -= deduction;
    deductionBySeverity[f.severity] = (deductionBySeverity[f.severity] ?? 0) + deduction;
  }
  const clamped = Math.max(0, Math.min(100, raw));
  return {
    score: Math.round(clamped),
    rawScore: Math.round(clamped * 100) / 100,
    totalFindings: findings.length,
    deductionBySeverity,
    formula:
      "100 - sum(deduction per finding: critical=8, high=4, medium=2, low=0.5), clamped to [0,100]. See docs/REPORTING.md.",
  };
}
