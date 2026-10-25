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

/**
 * Phase 7 security fix: CSV formula injection (a.k.a. "CSV injection",
 * CWE-1236). `title`/`category`/`url` come straight from crawled page
 * content (an untrusted page's <title>, meta description, etc.) with
 * no restriction on their first character. If a field's value happens
 * to start with `=`, `+`, `-`, or `@`, Excel/Google Sheets/LibreOffice
 * treat the whole cell as a formula when the CSV is opened — a crawled
 * page titled e.g. `=cmd|'/c calc'!A1` (old Excel DDE) or
 * `=HYPERLINK("http://evil","click")` would execute/act as a formula
 * for whoever opens this export, not just display as text. Prefixing
 * such a value with a single quote is the standard mitigation (OWASP
 * CSV Injection cheat sheet): spreadsheet apps then render the leading
 * quote-prefixed text as a literal string, never evaluate it.
 */
const FORMULA_TRIGGER_CHARS = new Set(["=", "+", "-", "@", "\t", "\r"]);

function neutralizeCsvFormula(value: string): string {
  if (value.length > 0 && FORMULA_TRIGGER_CHARS.has(value[0])) {
    return `'${value}`;
  }
  return value;
}

function escapeCsvField(value: string): string {
  const safe = neutralizeCsvFormula(value);
  if (/[",\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function generateCsv(payload: ReportPayload): string {
  const header = COLUMNS.join(",");
  const rows = payload.findings.map((f) =>
    COLUMNS.map((col) => escapeCsvField(String((f as unknown as Record<string, unknown>)[col] ?? ""))).join(",")
  );
  return [header, ...rows].join("\r\n") + "\r\n";
}
