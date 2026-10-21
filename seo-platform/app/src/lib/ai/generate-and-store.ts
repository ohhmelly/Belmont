/**
 * Wires the recommendation engine (pure function over findings) to
 * Postgres: loads a crawl job's real `findings` rows, runs the engine,
 * and persists the drafts as `ai_recommendations` rows.
 *
 * Idempotent per crawl job: re-running deletes any previous
 * recommendations for that job first (cheap full regeneration — there
 * is no partial-update concept for AI text, and crawl jobs are
 * infrequent), so calling this twice never leaves stale/duplicate rows.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { crawlJobs, findings, aiRecommendations, websites } from "@/db/app-schema";
import { createAiProviderFromEnv } from "./provider";
import { generateRecommendations, type EngineFinding } from "./recommendation-engine";

export interface GenerateAndStoreResult {
  crawlJobId: string;
  recommendationCount: number;
  aiProviderUsed: string; // "ollama" | "stub" | mixed summary
  aiAvailable: boolean;
}

export async function generateAndStoreRecommendations(crawlJobId: string): Promise<GenerateAndStoreResult> {
  const [job] = await db.select().from(crawlJobs).where(eq(crawlJobs.id, crawlJobId));
  if (!job) throw new Error(`crawl job ${crawlJobId} not found`);

  const [website] = await db.select().from(websites).where(eq(websites.id, job.websiteId));
  if (!website) throw new Error(`website ${job.websiteId} not found`);

  const rows = await db.select().from(findings).where(eq(findings.crawlJobId, crawlJobId));
  const engineFindings: EngineFinding[] = rows.map((r) => ({
    id: r.id,
    category: r.category,
    severity: r.severity,
    url: r.url,
    title: r.title,
    description: r.description,
    evidence: (r.evidence ?? {}) as Record<string, unknown>,
  }));

  const provider = createAiProviderFromEnv();
  const aiAvailable = provider.isConfigured() && (await provider.isAvailable());

  const drafts = await generateRecommendations(crawlJobId, website.id, website.url, engineFindings, provider);

  await db.delete(aiRecommendations).where(eq(aiRecommendations.crawlJobId, crawlJobId));
  if (drafts.length > 0) {
    await db.insert(aiRecommendations).values(
      drafts.map((d) => ({
        crawlJobId: d.crawlJobId,
        websiteId: d.websiteId,
        kind: d.kind,
        findingIds: d.findingIds,
        priority: d.priority,
        title: d.title,
        body: d.body,
        metadata: d.metadata,
      }))
    );
  }

  return {
    crawlJobId,
    recommendationCount: drafts.length,
    aiProviderUsed: aiAvailable ? provider.name : "stub-or-unavailable",
    aiAvailable,
  };
}
