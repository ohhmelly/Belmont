/**
 * Shapes the single structured payload every report format (PDF, HTML,
 * CSV, JSON) renders from — one source of truth so the formats can
 * never disagree with each other or with what's actually in Postgres.
 *
 * Every field here comes from a real `findings`/`ai_recommendations`
 * row or a deterministic computation over them (health-score.ts). There
 * is no field here for search volume, backlinks, rankings, or traffic —
 * those were never measured, so there is nowhere to put a fabricated
 * number even by accident.
 */
import { computeHealthScore, type HealthScoreResult } from "./health-score";

export interface ReportFinding {
  id: string;
  sourceEngine: string;
  url: string;
  canonicalUrl: string | null;
  httpStatus: number | null;
  severity: string;
  category: string;
  title: string;
  description: string;
  discoveredAt: string;
}

export interface ReportRecommendation {
  id: string;
  kind: string;
  findingIds: string[];
  priority: string | null;
  title: string;
  body: string;
  generatedBy: string;
}

export interface ReportPayload {
  meta: {
    websiteId: string;
    websiteUrl: string;
    organizationName: string;
    crawlJobId: string;
    crawlStartedAt: string | null;
    crawlFinishedAt: string | null;
    generatedAt: string;
  };
  healthScore: HealthScoreResult;
  summary: {
    totalFindings: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
    affectedUrlCount: number;
  };
  findings: ReportFinding[];
  recommendations: ReportRecommendation[];
  /** True when at least one recommendation came from a real AI call (not the template fallback). */
  aiAssisted: boolean;
}

export interface BuildReportPayloadInput {
  website: { id: string; url: string };
  organizationName: string;
  crawlJob: { id: string; startedAt: Date | null; finishedAt: Date | null };
  findings: {
    id: string;
    sourceEngine: string;
    url: string;
    canonicalUrl: string | null;
    httpStatus: number | null;
    severity: string;
    category: string;
    title: string;
    description: string;
    discoveredAt: Date;
  }[];
  recommendations: {
    id: string;
    kind: string;
    findingIds: unknown;
    priority: string | null;
    title: string;
    body: string;
    metadata: unknown;
  }[];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function buildReportPayload(input: BuildReportPayloadInput): ReportPayload {
  const healthScore = computeHealthScore(input.findings);

  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const urls = new Set<string>();
  for (const f of input.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    urls.add(f.url);
  }

  const recommendations: ReportRecommendation[] = input.recommendations.map((r) => {
    const metadata = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      kind: r.kind,
      findingIds: asStringArray(r.findingIds),
      priority: r.priority,
      title: r.title,
      body: r.body,
      generatedBy: typeof metadata.generatedBy === "string" ? metadata.generatedBy : "unknown",
    };
  });

  return {
    meta: {
      websiteId: input.website.id,
      websiteUrl: input.website.url,
      organizationName: input.organizationName,
      crawlJobId: input.crawlJob.id,
      crawlStartedAt: input.crawlJob.startedAt?.toISOString() ?? null,
      crawlFinishedAt: input.crawlJob.finishedAt?.toISOString() ?? null,
      generatedAt: new Date().toISOString(),
    },
    healthScore,
    summary: {
      totalFindings: input.findings.length,
      bySeverity,
      byCategory,
      affectedUrlCount: urls.size,
    },
    findings: input.findings.map((f) => ({
      id: f.id,
      sourceEngine: f.sourceEngine,
      url: f.url,
      canonicalUrl: f.canonicalUrl,
      httpStatus: f.httpStatus,
      severity: f.severity,
      category: f.category,
      title: f.title,
      description: f.description,
      discoveredAt: f.discoveredAt.toISOString(),
    })),
    recommendations,
    aiAssisted: recommendations.some((r) => r.generatedBy !== "template-fallback" && r.generatedBy !== "unknown"),
  };
}

/** Best recommendation text to show for a given finding: AI-generated when present, the finding's own description otherwise. */
export function recommendedActionForFinding(payload: ReportPayload, finding: ReportFinding): string {
  const match = payload.recommendations.find((r) => r.kind === "finding_explanation" && r.findingIds.includes(finding.id));
  if (match) return match.body;
  return finding.description || "No further detail was captured for this finding.";
}
