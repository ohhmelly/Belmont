/**
 * CSV report: one row per finding, as specified for Phase 4. Simple,
 * dependency-free RFC4180-ish escaping (quote fields containing a
 * comma, quote, or newline; double up embedded quotes).
 *
 * DECISION (report-polish pass): kept findings-only, unchanged. The
 * category score breakdown and history comparison added this phase are
 * not single rows of a "many rows, one shape" table — a second summary
 * CSV would mostly duplicate the JSON format's `categoryScores`/
 * `history` fields with a worse representation (CSV has no natural way
 * to express "4 categories, each with its own nested formula/severity
 * breakdown" without flattening it into something harder to read than
 * the JSON already is). The JSON format is documented as the one that
 * matters most for any future integration (see report-data.ts) and
 * carries the full breakdown; this file's job stays narrow and simple.
 */
import type { ReportPayload } from "./report-data";

const COLUMNS = ["severity", "category", "url", "title", "httpStatus", "sourceEngine", "discoveredAt"] as const;

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function generateCsv(payload: ReportPayload): string {
  const header = COLUMNS.join(",");
  const rows = payload.findings.map((f) =>
    COLUMNS.map((col) => escapeCsvField(String((f as unknown as Record<string, unknown>)[col] ?? ""))).join(",")
  );
  return [header, ...rows].join("\r\n") + "\r\n";
}
