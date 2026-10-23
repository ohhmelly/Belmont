/**
 * PDF report via pdfkit (pure JS, no Chromium/Puppeteer — see
 * docs/INTEGRATION_ARCHITECTURE.md §7: this sandbox has no
 * Chromium-family browser, and a self-hosted deployment target is
 * better off without that dependency for a report this simple).
 *
 * Renders the same `ReportPayload` the HTML/CSV/JSON formats use:
 * numbered sections (01 Executive Summary ... 07 Historical Comparison,
 * mirroring html.ts), health score with its formula stated, a category
 * score breakdown, findings grouped by category then severity, affected
 * URLs, recommended actions, report timestamp, website identity, and an
 * org-name branding slot.
 *
 * DESIGN CHOICE (documented per spec): the HTML report draws a circular
 * SVG score gauge, but pdfkit has no SVG/vector-arc primitive worth the
 * complexity for one ring — hand-rolling bezier-arc math in pdfkit for
 * a single gauge is disproportionate effort for a report this simple.
 * Instead, the PDF renders the overall score as large text (as before)
 * plus a clean colored bar per category (pdfkit's `rect().fill()` is
 * trivial and legible) — an honest adaptation, not a downgrade in the
 * information conveyed, which is all that matters here (no claim here
 * is visual, every claim is still the same real number).
 */
import PDFDocument from "pdfkit";
import type { ReportPayload, ReportFinding } from "./report-data";
import { recommendedActionForFinding } from "./report-data";
import { CATEGORY_ORDER, mapFindingCategory, type ReportCategory } from "./category-scores";

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_COLOR: Record<string, string> = {
  critical: "#b91c1c",
  high: "#c2410c",
  medium: "#a16207",
  low: "#4b5563",
};

/** Same thresholds as html.ts's scoreColor — kept in sync by hand (small enough that a shared module would be more indirection than it's worth). */
function scoreColor(score: number): string {
  if (score >= 80) return "#16a34a";
  if (score >= 60) return "#ca8a04";
  return "#dc2626";
}

const CATEGORY_SECTION_TITLES: Record<ReportCategory, string> = {
  technical: "Technical Findings",
  on_page: "On-Page Findings",
  content: "Content Findings",
  ai_visibility: "AI Visibility",
};
/** Section numbers: 01 Executive Summary, 02-05 the four category sections (in CATEGORY_ORDER), 06 Prioritized Action Plan, 07 Historical Comparison. */
const CATEGORY_SECTION_NUMBER: Record<ReportCategory, string> = Object.fromEntries(
  CATEGORY_ORDER.map((cat, i) => [cat, String(i + 2).padStart(2, "0")])
) as Record<ReportCategory, string>;

export async function generatePdf(payload: ReportPayload): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 50, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // --- Header / website identity / branding slot ---
  doc.fontSize(10).fillColor("#6b7280").text(payload.meta.organizationName);
  doc.fontSize(20).fillColor("#111827").text("Technical SEO Audit Report", { paragraphGap: 4 });
  doc
    .fontSize(10)
    .fillColor("#6b7280")
    .text(`${payload.meta.websiteUrl}`)
    .text(`Generated: ${payload.meta.generatedAt}`)
    .moveDown(1);

  // --- Health score ---
  doc.fontSize(14).fillColor("#111827").text("Overall Health Score");
  doc.fontSize(28).fillColor(scoreColor(payload.healthScore.score)).text(`${payload.healthScore.score}/100`, { continued: false });
  doc
    .fontSize(9)
    .fillColor("#6b7280")
    .text(payload.healthScore.formula, { width: 500 })
    .text(
      `Based on ${payload.summary.totalFindings} finding(s) across ${payload.summary.affectedUrlCount} affected URL(s).`
    )
    .moveDown(0.75);

  // --- Category score breakdown: one colored bar per category (see module doc comment for why a bar, not a ring, here) ---
  doc.fontSize(12).fillColor("#111827").text("Category Score Breakdown");
  const barX = 50;
  const barMaxWidth = 300;
  const barHeight = 14;
  for (const cs of payload.categoryScores) {
    const y = doc.y + 2;
    doc.fontSize(9).fillColor("#374151").text(`${cs.label} — ${cs.score}/100 (${cs.totalFindings} finding(s))`, barX, y);
    const trackY = doc.y + 2;
    doc.rect(barX, trackY, barMaxWidth, barHeight).fill("#e5e7eb");
    const fillWidth = Math.max(2, Math.round((barMaxWidth * Math.max(0, Math.min(100, cs.score))) / 100));
    doc.rect(barX, trackY, fillWidth, barHeight).fill(scoreColor(cs.score));
    doc.y = trackY + barHeight + 8;
  }
  doc.moveDown(0.5);

  // --- 01. Executive summary ---
  const summaryRec = payload.recommendations.find((r) => r.kind === "audit_summary");
  doc.fontSize(14).fillColor("#111827").text("01. Executive Summary");
  const summaryText =
    summaryRec?.body ??
    `This audit found ${payload.summary.totalFindings} issue(s): ${
      Object.entries(payload.summary.bySeverity)
        .map(([s, c]) => `${c} ${s}`)
        .join(", ") || "none"
    }.`;
  doc.fontSize(10).fillColor("#374151").text(summaryText, { width: 500 }).moveDown(1);

  // --- 02-05: findings grouped by category, then by severity within each category ---
  const findingsByCategory = new Map<ReportCategory, ReportFinding[]>();
  for (const cat of CATEGORY_ORDER) findingsByCategory.set(cat, []);
  for (const f of payload.findings) findingsByCategory.get(mapFindingCategory(f.category))!.push(f);
  const scoreByCategory = new Map(payload.categoryScores.map((s) => [s.category, s]));

  for (const cat of CATEGORY_ORDER) {
    doc.addPage();
    const cs = scoreByCategory.get(cat)!;
    doc
      .fontSize(14)
      .fillColor("#111827")
      .text(`${CATEGORY_SECTION_NUMBER[cat]}. ${CATEGORY_SECTION_TITLES[cat]}`);
    doc
      .fontSize(9)
      .fillColor(scoreColor(cs.score))
      .text(`${CATEGORY_SECTION_TITLES[cat]} score: ${cs.score}/100 (${cs.totalFindings} finding(s) in this category)`)
      .moveDown(0.5);

    const items = findingsByCategory.get(cat)!;
    if (items.length === 0) {
      doc.fontSize(10).fillColor("#6b7280").text("No findings in this category from this crawl.");
      continue;
    }
    const bySeverity = new Map<string, ReportFinding[]>();
    for (const sev of SEVERITY_ORDER) bySeverity.set(sev, []);
    for (const f of items) {
      if (!bySeverity.has(f.severity)) bySeverity.set(f.severity, []);
      bySeverity.get(f.severity)!.push(f);
    }
    for (const sev of bySeverity.keys()) {
      const sevItems = bySeverity.get(sev)!;
      if (sevItems.length === 0) continue;
      doc.moveDown(0.3).fontSize(11).fillColor(SEVERITY_COLOR[sev] ?? "#111827").text(`${sev.toUpperCase()} (${sevItems.length})`);
      for (const f of sevItems) {
        doc
          .fontSize(10)
          .fillColor("#111827")
          .text(`${f.title}`, { continued: false })
          .fontSize(8)
          .fillColor("#2563eb")
          .text(f.url, { width: 500 })
          .fontSize(9)
          .fillColor("#374151")
          .text(`Recommended action: ${recommendedActionForFinding(payload, f)}`, { width: 500 })
          .moveDown(0.3);
      }
    }
  }

  // --- 06. Prioritized action plan ---
  doc.addPage();
  doc.fontSize(14).fillColor("#111827").text("06. Prioritized Action Plan");
  const devTasks = [...payload.recommendations.filter((r) => r.kind === "dev_task")].sort(
    (a, b) => (SEVERITY_RANK[a.priority ?? "low"] ?? 9) - (SEVERITY_RANK[b.priority ?? "low"] ?? 9)
  );
  if (devTasks.length > 0) {
    for (const t of devTasks) {
      doc
        .fontSize(10)
        .fillColor(SEVERITY_COLOR[t.priority ?? "low"] ?? "#374151")
        .text(`[${(t.priority ?? "low").toUpperCase()}] `, { continued: true })
        .fillColor("#374151")
        .text(t.body, { width: 500 })
        .moveDown(0.3);
    }
  } else {
    doc.fontSize(10).fillColor("#6b7280").text("No developer remediation tasks were generated for this crawl.");
  }

  // --- 07. Historical comparison (omitted cleanly, not as an error, when there's no prior completed crawl) ---
  if (payload.history) {
    const h = payload.history;
    doc.addPage();
    doc.fontSize(14).fillColor("#111827").text("07. Historical Comparison");
    doc
      .fontSize(9)
      .fillColor("#6b7280")
      .text(`Compared against the previous completed crawl (job ${h.previousCrawlJobId} -> ${h.currentCrawlJobId}).`)
      .moveDown(0.5);

    const histBars: Array<{ label: string; count: number; color: string }> = [
      { label: "New", count: h.newCount, color: "#dc2626" },
      { label: "Resolved", count: h.resolvedCount, color: "#16a34a" },
      { label: "Persisting", count: h.persistingCount, color: "#ca8a04" },
    ];
    const maxCount = Math.max(1, ...histBars.map((b) => b.count));
    const histBarMaxWidth = 300;
    const histBarHeight = 16;
    for (const b of histBars) {
      const y = doc.y + 2;
      doc.fontSize(9).fillColor("#374151").text(`${b.label}: ${b.count}`, barX, y);
      const trackY = doc.y + 2;
      const w = Math.max(b.count > 0 ? 3 : 0, Math.round((histBarMaxWidth * b.count) / maxCount));
      doc.rect(barX, trackY, w, histBarHeight).fill(b.color);
      doc.y = trackY + histBarHeight + 6;
    }
    doc.moveDown(0.5);

    if (h.newSample.length > 0) {
      doc.fontSize(11).fillColor("#111827").text(`New issues since last crawl (${h.newCount})`);
      for (const f of h.newSample) {
        doc.fontSize(9).fillColor("#374151").text(`• [${f.severity.toUpperCase()}] ${f.title} — ${f.url}`, { width: 500 });
      }
      doc.moveDown(0.5);
    }
    if (h.resolvedSample.length > 0) {
      doc.fontSize(11).fillColor("#111827").text(`Resolved since last crawl (${h.resolvedCount})`);
      for (const f of h.resolvedSample) {
        doc.fontSize(9).fillColor("#374151").text(`• [${f.severity.toUpperCase()}] ${f.title} — ${f.url}`, { width: 500 });
      }
    }
  }

  // --- Affected URLs ---
  doc.addPage();
  doc.fontSize(14).fillColor("#111827").text("Affected URLs");
  const uniqueUrls = [...new Set(payload.findings.map((f) => f.url))];
  doc.fontSize(9).fillColor("#2563eb");
  for (const url of uniqueUrls) {
    doc.text(url, { width: 500 });
  }

  doc
    .moveDown(1.5)
    .fontSize(8)
    .fillColor("#9ca3af")
    .text(
      "This report reflects only issues this crawl actually measured. It makes no claim about search rankings, traffic, or backlinks, which were not measured."
    );

  doc.end();
  return done;
}
