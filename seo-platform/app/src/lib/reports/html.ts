/**
 * HTML report: a self-contained, server-rendered HTML document from the
 * same `ReportPayload` the PDF/CSV/JSON formats use. No client JS, no
 * external assets — safe to open standalone or email as an attachment.
 */
import type { ReportPayload } from "./report-data";
import { recommendedActionForFinding } from "./report-data";

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function severityBadge(severity: string): string {
  const colors: Record<string, string> = {
    critical: "#b91c1c",
    high: "#c2410c",
    medium: "#a16207",
    low: "#4b5563",
  };
  const color = colors[severity] ?? "#4b5563";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${color};color:#fff;font-size:12px;font-weight:600;text-transform:uppercase;">${escapeHtml(severity)}</span>`;
}

export function generateHtml(payload: ReportPayload): string {
  const findingsSorted = [...payload.findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
  );
  const summary = payload.recommendations.find((r) => r.kind === "audit_summary");
  const devTasks = payload.recommendations.filter((r) => r.kind === "dev_task");
  const otherRecs = payload.recommendations.filter(
    (r) => r.kind !== "audit_summary" && r.kind !== "dev_task" && r.kind !== "finding_explanation" && r.kind !== "title_meta_suggestion"
  );

  const findingsRows = findingsSorted
    .map(
      (f) => `
      <tr>
        <td>${severityBadge(f.severity)}</td>
        <td>${escapeHtml(f.category)}</td>
        <td style="word-break:break-all;"><a href="${escapeHtml(f.url)}">${escapeHtml(f.url)}</a></td>
        <td>${escapeHtml(f.title)}</td>
        <td>${escapeHtml(recommendedActionForFinding(payload, f))}</td>
      </tr>`
    )
    .join("\n");

  const devTaskItems = devTasks.map((t) => `<li>${escapeHtml(t.body)}</li>`).join("\n");
  const otherRecsHtml = otherRecs
    .map((r) => `<div class="rec"><h3>${escapeHtml(r.title)}</h3><p>${escapeHtml(r.body)}</p></div>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SEO Audit Report — ${escapeHtml(payload.meta.websiteUrl)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#111827; max-width: 960px; margin: 2rem auto; padding: 0 1rem; line-height:1.5; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.15rem; margin-top: 2rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.25rem; }
  .meta { color:#6b7280; font-size: 0.9rem; }
  .score-box { display:flex; align-items:center; gap:1rem; margin: 1rem 0; padding: 1rem; border:1px solid #e5e7eb; border-radius:8px; background:#f9fafb; }
  .score-number { font-size: 2.5rem; font-weight: 700; }
  .score-formula { color:#6b7280; font-size: 0.8rem; max-width: 60ch; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.9rem; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  th { color:#6b7280; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
  .rec { margin: 0.75rem 0; padding: 0.75rem; border: 1px solid #e5e7eb; border-radius: 6px; }
  .rec h3 { margin: 0 0 0.25rem; font-size: 0.95rem; }
  .disclaimer { font-size: 0.75rem; color:#9ca3af; margin-top: 2.5rem; border-top: 1px solid #e5e7eb; padding-top: 0.75rem; }
  ul.dev-tasks { font-size: 0.9rem; }
</style>
</head>
<body>
  <header>
    <div class="meta">${escapeHtml(payload.meta.organizationName)}</div>
    <h1>Technical SEO Audit Report</h1>
    <div class="meta">${escapeHtml(payload.meta.websiteUrl)} — generated ${escapeHtml(payload.meta.generatedAt)}</div>
  </header>

  <section>
    <h2>Health score</h2>
    <div class="score-box">
      <div class="score-number">${payload.healthScore.score}<span style="font-size:1rem;color:#6b7280;">/100</span></div>
      <div class="score-formula">${escapeHtml(payload.healthScore.formula)} Based on ${payload.summary.totalFindings} finding(s) across ${payload.summary.affectedUrlCount} URL(s) from this crawl.</div>
    </div>
  </section>

  <section>
    <h2>Executive summary</h2>
    <p>${escapeHtml(summary ? summary.body : `This audit found ${payload.summary.totalFindings} issue(s): ${Object.entries(payload.summary.bySeverity).map(([s, c]) => `${c} ${s}`).join(", ") || "none"}.`)}</p>
  </section>

  <section>
    <h2>Findings by severity</h2>
    <table>
      <thead><tr><th>Severity</th><th>Category</th><th>URL</th><th>Finding</th><th>Recommended action</th></tr></thead>
      <tbody>
        ${findingsRows || '<tr><td colspan="5">No findings.</td></tr>'}
      </tbody>
    </table>
  </section>

  ${otherRecsHtml ? `<section><h2>Additional recommendations</h2>${otherRecsHtml}</section>` : ""}

  ${
    devTaskItems
      ? `<section><h2>Developer remediation tasks</h2><ul class="dev-tasks">${devTaskItems}</ul></section>`
      : ""
  }

  <div class="disclaimer">
    This report reflects only issues this crawl actually measured. It does not include and makes no claim about search rankings, traffic, or backlinks — those were not measured. ${
      payload.aiAssisted
        ? "Explanations/suggestions marked as AI-generated were produced by a local AI model and should be reviewed before acting on them."
        : "No AI model was available when this report was generated; recommended actions above are the crawler's own finding descriptions."
    }
  </div>
</body>
</html>`;
}
