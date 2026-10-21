/**
 * PDF report via pdfkit (pure JS, no Chromium/Puppeteer — see
 * docs/INTEGRATION_ARCHITECTURE.md §7: this sandbox has no
 * Chromium-family browser, and a self-hosted deployment target is
 * better off without that dependency for a report this simple).
 *
 * Renders the same `ReportPayload` the HTML/CSV/JSON formats use:
 * executive summary, health score with its formula stated, findings
 * grouped by severity, affected URLs, recommended actions, report
 * timestamp, website identity, and an org-name branding slot.
 */
import PDFDocument from "pdfkit";
import type { ReportPayload } from "./report-data";
import { recommendedActionForFinding } from "./report-data";

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;
const SEVERITY_COLOR: Record<string, string> = {
  critical: "#b91c1c",
  high: "#c2410c",
  medium: "#a16207",
  low: "#4b5563",
};

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
  doc.fontSize(14).fillColor("#111827").text("Health score");
  doc.fontSize(28).fillColor("#111827").text(`${payload.healthScore.score}/100`, { continued: false });
  doc
    .fontSize(9)
    .fillColor("#6b7280")
    .text(payload.healthScore.formula, { width: 500 })
    .text(
      `Based on ${payload.summary.totalFindings} finding(s) across ${payload.summary.affectedUrlCount} affected URL(s).`
    )
    .moveDown(1);

  // --- Executive summary ---
  const summaryRec = payload.recommendations.find((r) => r.kind === "audit_summary");
  doc.fontSize(14).fillColor("#111827").text("Executive summary");
  const summaryText =
    summaryRec?.body ??
    `This audit found ${payload.summary.totalFindings} issue(s): ${
      Object.entries(payload.summary.bySeverity)
        .map(([s, c]) => `${c} ${s}`)
        .join(", ") || "none"
    }.`;
  doc.fontSize(10).fillColor("#374151").text(summaryText, { width: 500 }).moveDown(1);

  // --- Findings grouped by severity ---
  doc.fontSize(14).fillColor("#111827").text("Findings");
  const bySeverity = new Map<string, ReportPayload["findings"]>();
  for (const sev of SEVERITY_ORDER) bySeverity.set(sev, []);
  for (const f of payload.findings) {
    if (!bySeverity.has(f.severity)) bySeverity.set(f.severity, []);
    bySeverity.get(f.severity)!.push(f);
  }

  for (const sev of bySeverity.keys()) {
    const items = bySeverity.get(sev)!;
    if (items.length === 0) continue;
    doc.moveDown(0.5).fontSize(12).fillColor(SEVERITY_COLOR[sev] ?? "#111827").text(`${sev.toUpperCase()} (${items.length})`);
    for (const f of items) {
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
        .moveDown(0.4);
    }
  }

  // --- Developer remediation tasks ---
  const devTasks = payload.recommendations.filter((r) => r.kind === "dev_task");
  if (devTasks.length > 0) {
    doc.addPage();
    doc.fontSize(14).fillColor("#111827").text("Developer remediation tasks");
    for (const t of devTasks) {
      doc.fontSize(10).fillColor("#374151").text(`• ${t.body}`, { width: 500 }).moveDown(0.2);
    }
  }

  // --- Affected URLs ---
  doc.moveDown(1).fontSize(14).fillColor("#111827").text("Affected URLs");
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
