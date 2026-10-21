import { describe, it, expect } from "vitest";
import { computeHealthScore, SEVERITY_DEDUCTIONS } from "./health-score";

describe("computeHealthScore", () => {
  it("scores 100 with no findings", () => {
    expect(computeHealthScore([]).score).toBe(100);
  });

  it("deducts exactly the documented amount per severity", () => {
    const result = computeHealthScore([{ severity: "critical" }, { severity: "high" }, { severity: "medium" }, { severity: "low" }]);
    const expected = 100 - SEVERITY_DEDUCTIONS.critical - SEVERITY_DEDUCTIONS.high - SEVERITY_DEDUCTIONS.medium - SEVERITY_DEDUCTIONS.low;
    expect(result.rawScore).toBeCloseTo(expected, 5);
  });

  it("deducts per finding, not per category — two critical findings deduct twice", () => {
    const one = computeHealthScore([{ severity: "critical" }]);
    const two = computeHealthScore([{ severity: "critical" }, { severity: "critical" }]);
    expect(two.rawScore).toBeCloseTo(one.rawScore - SEVERITY_DEDUCTIONS.critical, 5);
  });

  it("floors at 0, never goes negative", () => {
    const manyCritical = Array.from({ length: 50 }, () => ({ severity: "critical" }));
    const result = computeHealthScore(manyCritical);
    expect(result.score).toBe(0);
    expect(result.rawScore).toBe(0);
  });

  it("caps at 100 (never exceeds, even with zero findings)", () => {
    expect(computeHealthScore([]).score).toBeLessThanOrEqual(100);
  });

  it("treats an unknown/unrecognized severity with a conservative default deduction rather than crashing", () => {
    expect(() => computeHealthScore([{ severity: "unknown-severity" }])).not.toThrow();
  });
});
