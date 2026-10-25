/**
 * Phase 7 security regression: CSV formula injection (CWE-1236). A
 * crawled page's title/category/url is attacker-controlled content
 * (the page owner writes their own <title>) and flows unmodified into
 * `findings.title`/`category`/`url`, then straight into this CSV
 * export. If any of those fields starts with `=`, `+`, `-`, `@`, a
 * tab, or a CR, Excel/Sheets/LibreOffice will treat the whole cell as
 * a formula when a user opens the downloaded report — not just text.
 * `generateCsv` must neutralize that leading character so the cell is
 * always read back as a literal string.
 */
import { describe, it, expect } from "vitest";
import { generateCsv } from "./csv";
import type { ReportPayload } from "./report-data";

function payloadWithFinding(title: string, category = "technical", url = "https://example.com/"): ReportPayload {
  return {
    meta: {
      websiteId: "w1",
      websiteUrl: url,
      organizationName: "Acme",
      crawlJobId: "c1",
      crawlStartedAt: null,
      crawlFinishedAt: null,
      generatedAt: "2026-01-01T00:00:00.000Z",
    },
    healthScore: { score: 100, rawScore: 100, totalFindings: 1, deductionBySeverity: {}, formula: "f" },
    categoryScores: [],
    summary: { totalFindings: 1, bySeverity: {}, byCategory: {}, affectedUrlCount: 1 },
    findings: [
      {
        id: "f1",
        sourceEngine: "siteone",
        url,
        canonicalUrl: null,
        httpStatus: 200,
        severity: "low",
        category,
        title,
        description: "",
        discoveredAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    recommendations: [],
    aiAssisted: false,
    history: null,
  };
}

describe("generateCsv — formula injection is neutralized", () => {
  it.each([`=cmd|'/c calc'!A1`, `+1+1`, `-2+3`, `@SUM(1)`, `=1+1`])(
    "prefixes a title starting with a formula-trigger character (%s) with a quote",
    (malicious) => {
      const csv = generateCsv(payloadWithFinding(malicious));
      const lines = csv.trim().split("\r\n");
      const dataLine = lines[1];
      // The raw value must never appear unprefixed at the start of a cell.
      expect(dataLine.startsWith(malicious)).toBe(false);
      // The neutralized form (leading single quote) must be present,
      // proving the content survived, just made inert.
      expect(dataLine).toContain(`'${malicious}`);
    }
  );

  it("neutralizes a formula-trigger character even when the field also needs CSV quoting (comma/quote)", () => {
    const malicious = `=HYPERLINK("http://evil.example","click")`;
    const csv = generateCsv(payloadWithFinding(malicious));
    const lines = csv.trim().split("\r\n");
    const dataLine = lines[1];
    expect(dataLine.startsWith(`"${malicious}`)).toBe(false);
    // Neutralized + CSV-quote-escaped form: leading `'`, then the value
    // with every `"` doubled, wrapped in an outer pair of quotes.
    expect(dataLine).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`);
  });

  it("leaves an ordinary title untouched", () => {
    const csv = generateCsv(payloadWithFinding("Missing meta description"));
    expect(csv).toContain("Missing meta description");
    expect(csv).not.toContain("'Missing");
  });

  it("still quotes fields containing commas/quotes after neutralization", () => {
    const csv = generateCsv(payloadWithFinding(`=A1,"quoted"`));
    const lines = csv.trim().split("\r\n");
    // Must be wrapped in quotes (contains a comma) and start with the
    // neutralizing single quote inside the CSV quoting.
    expect(lines[1]).toContain(`"'=A1,""quoted"""`);
  });
});
