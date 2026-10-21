/**
 * Report generator orchestrator (Phase 4).
 *
 * Reads the real `websites` / `crawl_jobs` / `findings` /
 * `ai_recommendations` rows for one crawl job from Postgres, shapes them
 * into one `ReportPayload` (report-data.ts), renders all four formats,
 * writes them to disk under the report storage root, and records one
 * `reports` row per format.
 *
 * This module does not call the AI provider itself — AI recommendations
 * must already exist (or the caller accepts there are none, in which
 * case `recommendedActionForFinding` falls back to the finding's own
 * description, per spec).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { websites, crawlJobs, findings, aiRecommendations, reports } from "@/db/app-schema";
import { organizations } from "@/db/auth-schema";
import { buildReportPayload, type ReportPayload } from "./report-data";
import { generateCsv } from "./csv";
import { generateHtml } from "./html";
import { generatePdf } from "./pdf";

export type ReportFormat = "pdf" | "html" | "csv" | "json";
export const ALL_FORMATS: ReportFormat[] = ["pdf", "html", "csv", "json"];

const CONTENT_TYPES: Record<ReportFormat, string> = {
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
};

export function reportsStorageRoot(): string {
  return process.env.STORAGE_REPORTS_DIR ?? path.resolve(process.cwd(), "storage", "reports");
}

export function contentTypeForFormat(format: string): string {
  return CONTENT_TYPES[format as ReportFormat] ?? "application/octet-stream";
}

async function loadPayload(crawlJobId: string): Promise<ReportPayload> {
  const [job] = await db.select().from(crawlJobs).where(eq(crawlJobs.id, crawlJobId));
  if (!job) throw new Error(`crawl job ${crawlJobId} not found`);

  const [website] = await db.select().from(websites).where(eq(websites.id, job.websiteId));
  if (!website) throw new Error(`website ${job.websiteId} not found`);

  const [org] = await db.select().from(organizations).where(eq(organizations.id, website.organizationId));

  const findingRows = await db.select().from(findings).where(eq(findings.crawlJobId, crawlJobId));
  const recommendationRows = await db.select().from(aiRecommendations).where(eq(aiRecommendations.crawlJobId, crawlJobId));

  return buildReportPayload({
    website: { id: website.id, url: website.url },
    organizationName: org?.name ?? "Unknown organization",
    crawlJob: { id: job.id, startedAt: job.startedAt, finishedAt: job.finishedAt },
    findings: findingRows,
    recommendations: recommendationRows,
  });
}

function renderFormat(format: ReportFormat, payload: ReportPayload): Promise<Buffer> | Buffer {
  switch (format) {
    case "json":
      return Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    case "csv":
      return Buffer.from(generateCsv(payload), "utf8");
    case "html":
      return Buffer.from(generateHtml(payload), "utf8");
    case "pdf":
      return generatePdf(payload);
  }
}

export interface GeneratedReport {
  id: string;
  format: ReportFormat;
  filePath: string; // relative to reportsStorageRoot()
  healthScore: number;
}

/**
 * Generate every requested format (default: all four) for one crawl
 * job, write the files to disk, and insert one `reports` row per
 * format. Returns the inserted rows (with ids) for the caller to link
 * to (e.g. a download route).
 */
export async function generateReportsForCrawlJob(
  crawlJobId: string,
  formats: ReportFormat[] = ALL_FORMATS
): Promise<GeneratedReport[]> {
  const payload = await loadPayload(crawlJobId);
  const root = reportsStorageRoot();
  const dir = path.join(root, payload.meta.websiteId, crawlJobId);
  await fs.mkdir(dir, { recursive: true });

  const results: GeneratedReport[] = [];
  for (const format of formats) {
    const buffer = await renderFormat(format, payload);
    const fileName = `report.${format}`;
    const absolutePath = path.join(dir, fileName);
    await fs.writeFile(absolutePath, buffer);
    const relativePath = path.relative(root, absolutePath);

    const [row] = await db
      .insert(reports)
      .values({
        websiteId: payload.meta.websiteId,
        crawlJobId,
        format,
        healthScore: payload.healthScore.score,
        filePath: relativePath,
      })
      .returning();

    results.push({ id: row.id, format, filePath: relativePath, healthScore: payload.healthScore.score });
  }
  return results;
}

/** Read a previously generated report's file back off disk, by its `reports` row. */
export async function readReportFile(filePath: string): Promise<Buffer> {
  const root = reportsStorageRoot();
  const resolved = path.resolve(root, filePath);
  // Defense in depth: filePath always comes from our own DB rows (never
  // user input directly), but refuse to ever read outside the storage
  // root regardless.
  if (!resolved.startsWith(path.resolve(root))) {
    throw new Error("Refusing to read a report path outside the storage root");
  }
  return fs.readFile(resolved);
}
