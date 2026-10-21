/**
 * CSV report: one row per finding, as specified for Phase 4. Simple,
 * dependency-free RFC4180-ish escaping (quote fields containing a
 * comma, quote, or newline; double up embedded quotes).
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
