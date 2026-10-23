/**
 * HTML report: a self-contained, server-rendered HTML document from the
 * same `ReportPayload` the PDF/CSV/JSON formats use. No client JS, no
 * external assets, no charting library — every visual (score gauge,
 * category bars, history chart) is hand-rolled inline SVG so this
 * deployment target never gains a chart-library dependency for a
 * handful of shapes. Safe to open standalone or email as an attachment.
 *
 * Numbered sections follow docs/DESIGN_UPDATES.md's "Competitive
 * reference" #3 (named, numbered sections read as more complete/
 * professional than a flat findings list) and the report-polish spec:
 * 01 Executive Summary, 02 Technical Findings, 03 On-Page Findings,
 * 04 Content Findings, 05 AI Visibility, 06 Prioritized Action Plan,
 * 07 Historical Comparison (omitted cleanly, not as an error, when
 * there's only one completed crawl for this website so far).
 */
import type { ReportPayload, ReportFinding } from "./report-data";
import { recommendedActionForFinding } from "./report-data";
import { CATEGORY_ORDER, CATEGORY_LABELS, mapFindingCategory, type ReportCategory } from "./category-scores";

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Section titles exactly as named in the spec (note: "AI Visibility", NOT "AI Visibility Findings" — kept in sync with pdf.ts's CATEGORY_SECTION_TITLES by hand). */
const CATEGORY_SECTION_TITLES: Record<ReportCategory, string> = {
  technical: "Technical Findings",
  on_page: "On-Page Findings",
  content: "Content Findings",
  ai_visibility: "AI Visibility",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Same green/amber/red thresholds docs/DESIGN_UPDATES.md's competitive research found used consistently across competitor tools (green >=80, amber 60-79, red <60). */
function scoreColor(score: number): string {
  if (score >= 80) return "#16a34a";
  if (score >= 60) return "#ca8a04";
  return "#dc2626";
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

/** Circular score gauge — inline SVG, no library. A ring whose filled arc length is proportional to `score`/100, drawn via the standard stroke-dasharray/dashoffset trick. */
function scoreGaugeSvg(score: number, size = 170, strokeWidth = 16): string {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);
  const color = scoreColor(score);
  const center = size / 2;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Overall health score: ${score} out of 100">
    <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#e5e7eb" stroke-width="${strokeWidth}" />
    <circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"
      stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" stroke-linecap="round"
      transform="rotate(-90 ${center} ${center})" />
    <text x="50%" y="46%" text-anchor="middle" dominant-baseline="middle" font-size="40" font-weight="700" fill="#111827" font-family="-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">${score}</text>
    <text x="50%" y="66%" text-anchor="middle" dominant-baseline="middle" font-size="13" fill="#6b7280" font-family="-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">/ 100</text>
  </svg>`;
}

/** The "N scores in a row" tile pattern from the competitive research, adapted to our 4 categories. */
function categoryTileHtml(label: string, score: number, totalFindings: number): string {
  const color = scoreColor(score);
  const width = Math.max(0, Math.min(100, score));
  return `<div class="cat-tile">
    <div class="cat-label">${escapeHtml(label)}</div>
    <div class="cat-score" style="color:${color};">${score}</div>
    <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${width}%;background:${color};"></div></div>
    <div class="cat-meta">${totalFindings} finding${totalFindings === 1 ? "" : "s"}</div>
  </div>`;
}

/** Simple horizontal bar chart (inline SVG) for the New / Resolved / Persisting counts from findings-diff.ts. */
function historyBarChartSvg(history: NonNullable<ReportPayload["history"]>): string {
  const bars: Array<{ label: string; count: number; color: string }> = [
    { label: "New", count: history.newCount, color: "#dc2626" },
    { label: "Resolved", count: history.resolvedCount, color: "#16a34a" },
    { label: "Persisting", count: history.persistingCount, color: "#ca8a04" },
  ];
  const maxCount = Math.max(1, ...bars.map((b) => b.count));
  const labelWidth = 92;
  const chartWidth = 380;
  const barHeight = 26;
  const gap = 16;
  const svgWidth = labelWidth + chartWidth + 50;
  const svgHeight = bars.length * (barHeight + gap);

  const rows = bars
    .map((b, i) => {
      const y = i * (barHeight + gap);
      const w = Math.max(b.count > 0 ? 3 : 0, Math.round(chartWidth * (b.count / maxCount)));
      return `<g>
        <text x="0" y="${y + barHeight / 2 + 4}" font-size="12" fill="#374151" font-family="-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">${escapeHtml(b.label)}</text>
        <rect x="${labelWidth}" y="${y}" width="${w}" height="${barHeight}" fill="${b.color}" rx="4" />
        <text x="${labelWidth + w + 8}" y="${y + barHeight / 2 + 4}" font-size="12" fill="#111827" font-family="-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif">${b.count}</text>
      </g>`;
    })
    .join("\n");

  return `<svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-label="New, resolved, and persisting finding counts since the previous crawl">
    ${rows}
  </svg>`;
}

function findingsTable(payload: ReportPayload, findings: ReportFinding[]): string {
  if (findings.length === 0) {
    return `<p class="muted">No findings in this category from this crawl.</p>`;
  }
  const sorted = [...findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  const rows = sorted
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
  return `<table>
    <thead><tr><th>Severity</th><th>Category</th><th>URL</th><th>Finding</th><th>Recommended action</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function generateHtml(payload: ReportPayload): string {
  const summary = payload.recommendations.find((r) => r.kind === "audit_summary");
  const devTasks = [...payload.recommendations.filter((r) => r.kind === "dev_task")].sort(
    (a, b) => (SEVERITY_ORDER[a.priority ?? "low"] ?? 9) - (SEVERITY_ORDER[b.priority ?? "low"] ?? 9)
  );
  const otherRecs = payload.recommendations.filter(
    (r) => r.kind !== "audit_summary" && r.kind !== "dev_task" && r.kind !== "finding_explanation" && r.kind !== "title_meta_suggestion"
  );

  const findingsByCategory = new Map<ReportCategory, ReportFinding[]>();
  for (const cat of CATEGORY_ORDER) findingsByCategory.set(cat, []);
  for (const f of payload.findings) {
    findingsByCategory.get(mapFindingCategory(f.category))!.push(f);
  }
  const scoreByCategory = new Map(payload.categoryScores.map((s) => [s.category, s]));

  const categoryTiles = payload.categoryScores.map((s) => categoryTileHtml(s.label, s.score, s.totalFindings)).join("\n");

  const findingsSectionsHtml = CATEGORY_ORDER.map((cat, idx) => {
    const sectionNumber = String(idx + 2).padStart(2, "0"); // 02-05 (01 is Executive Summary)
    const score = scoreByCategory.get(cat)!;
    const list = findingsByCategory.get(cat)!;
    return `<section>
      <h2>${sectionNumber}. ${escapeHtml(CATEGORY_SECTION_TITLES[cat])}</h2>
      <p class="section-score-context">${CATEGORY_LABELS[cat]} score: <strong style="color:${scoreColor(score.score)};">${score.score}/100</strong> based on ${score.totalFindings} finding(s) in this category.</p>
      ${findingsTable(payload, list)}
    </section>`;
  }).join("\n");

  const devTaskItems = devTasks
    .map((t) => `<li><strong>${escapeHtml((t.priority ?? "").toUpperCase())}</strong> — ${escapeHtml(t.body)}</li>`)
    .join("\n");

  const otherRecsHtml = otherRecs
    .map((r) => `<div class="rec"><h3>${escapeHtml(r.title)}</h3><p>${escapeHtml(r.body)}</p></div>`)
    .join("\n");

  const historySection = payload.history
    ? (() => {
        const h = payload.history!;
        const sampleHtml = (items: typeof h.newSample, emptyText: string) =>
          items.length === 0
            ? `<p class="muted">${emptyText}</p>`
            : `<ul class="history-sample">${items
                .map((f) => `<li>${severityBadge(f.severity)} <strong>${escapeHtml(f.title)}</strong> — <span style="word-break:break-all;">${escapeHtml(f.url)}</span></li>`)
                .join("\n")}</ul>`;
        return `<section>
          <h2>07. Historical Comparison</h2>
          <p class="section-score-context">Compared against the previous completed crawl (job ${escapeHtml(h.previousCrawlJobId)} &rarr; ${escapeHtml(h.currentCrawlJobId)}).</p>
          ${historyBarChartSvg(h)}
          <h3>New issues since last crawl (${h.newCount})</h3>
          ${sampleHtml(h.newSample, "No new issues since the previous crawl.")}
          <h3>Resolved since last crawl (${h.resolvedCount})</h3>
          ${sampleHtml(h.resolvedSample, "No issues were resolved since the previous crawl.")}
        </section>`;
      })()
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SEO Audit Report — ${escapeHtml(payload.meta.websiteUrl)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#111827; max-width: 980px; margin: 2rem auto; padding: 0 1rem; line-height:1.5; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.15rem; margin-top: 2rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.25rem; }
  h3 { font-size: 0.95rem; margin-top: 1.25rem; }
  .meta { color:#6b7280; font-size: 0.9rem; }
  .muted { color:#6b7280; font-size: 0.9rem; }
  .score-box { display:flex; align-items:center; gap:1.5rem; margin: 1rem 0; padding: 1rem; border:1px solid #e5e7eb; border-radius:8px; background:#f9fafb; flex-wrap: wrap; }
  .score-formula { color:#6b7280; font-size: 0.8rem; max-width: 56ch; }
  .category-row { display:flex; gap: 0.75rem; flex-wrap: wrap; margin: 1rem 0; }
  .cat-tile { flex: 1 1 180px; min-width: 150px; border:1px solid #e5e7eb; border-radius:8px; padding: 0.75rem 1rem; background:#fff; }
  .cat-label { font-size: 0.75rem; text-transform: uppercase; color:#6b7280; font-weight:600; }
  .cat-score { font-size: 1.75rem; font-weight: 700; }
  .cat-bar-track { height: 6px; border-radius: 3px; background:#e5e7eb; margin: 0.4rem 0; overflow:hidden; }
  .cat-bar-fill { height: 100%; border-radius: 3px; }
  .cat-meta { font-size: 0.75rem; color:#6b7280; }
  .section-score-context { color:#374151; font-size: 0.85rem; background:#f9fafb; border-left: 3px solid #d1d5db; padding: 0.4rem 0.75rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.9rem; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  th { color:#6b7280; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
  .rec { margin: 0.75rem 0; padding: 0.75rem; border: 1px solid #e5e7eb; border-radius: 6px; }
  .rec h3 { margin: 0 0 0.25rem; }
  .disclaimer { font-size: 0.75rem; color:#9ca3af; margin-top: 2.5rem; border-top: 1px solid #e5e7eb; padding-top: 0.75rem; }
  ul.dev-tasks, ul.history-sample { font-size: 0.9rem; padding-left: 1.1rem; }
  ul.history-sample li { margin-bottom: 0.35rem; }
</style>
</head>
<body>
  <header>
    <div class="meta">${escapeHtml(payload.meta.organizationName)}</div>
    <h1>Technical SEO Audit Report</h1>
    <div class="meta">${escapeHtml(payload.meta.websiteUrl)} — generated ${escapeHtml(payload.meta.generatedAt)}</div>
  </header>

  <section>
    <div class="score-box">
      ${scoreGaugeSvg(payload.healthScore.score)}
      <div class="score-formula">${escapeHtml(payload.healthScore.formula)} Based on ${payload.summary.totalFindings} finding(s) across ${payload.summary.affectedUrlCount} URL(s) from this crawl.</div>
    </div>
    <div class="category-row">${categoryTiles}</div>
  </section>

  <section>
    <h2>01. Executive Summary</h2>
    <p>${escapeHtml(summary ? summary.body : `This audit found ${payload.summary.totalFindings} issue(s): ${Object.entries(payload.summary.bySeverity).map(([s, c]) => `${c} ${s}`).join(", ") || "none"}.`)}</p>
  </section>

  ${findingsSectionsHtml}

  <section>
    <h2>06. Prioritized Action Plan</h2>
    ${
      devTaskItems
        ? `<ul class="dev-tasks">${devTaskItems}</ul>`
        : `<p class="muted">No developer remediation tasks were generated for this crawl.</p>`
    }
    ${otherRecsHtml}
  </section>

  ${historySection}

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
