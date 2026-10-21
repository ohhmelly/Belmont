/**
 * Historical comparison between two crawls of the same website (Phase 5).
 *
 * Finding ids are regenerated on every crawl (each `findings` row belongs
 * to exactly one `crawl_jobs` row), so "is this the same issue as before"
 * can never be answered by comparing ids. Instead we match on a stable
 * key — `category` + the affected `url` — which is stable across crawls
 * for the same real-world issue: the same page having the same category
 * of defect again is the same issue continuing; a different `url` or a
 * different `category` is a distinct issue.
 *
 * This is computed on demand from the existing `findings` rows of the
 * website's two most recent COMPLETED crawl jobs — no new table, per the
 * spec's "computing on demand from existing data is fine" guidance.
 */
import { eq, desc, and } from "drizzle-orm";
import { db } from "@/db";
import { crawlJobs, findings } from "@/db/app-schema";

export type FindingRow = typeof findings.$inferSelect;

export interface FindingsDiff {
  /** Present in the current crawl, absent (by key) from the previous one. */
  newFindings: FindingRow[];
  /** Present in the previous crawl, absent (by key) from the current one — i.e. fixed. */
  resolvedFindings: FindingRow[];
  /** Present in both crawls (by key) — still an open issue. */
  persistingFindings: FindingRow[];
  previousCrawlJobId: string;
  currentCrawlJobId: string;
}

/** The stable identity of a finding across crawls: category + affected URL. */
export function findingKey(f: Pick<FindingRow, "category" | "url">): string {
  return `${f.category}::${f.url}`;
}

/**
 * Pure comparison function, exported for unit testing without a database.
 * `previous` is the earlier crawl's findings, `current` the later one's.
 */
export function diffFindings(
  previous: FindingRow[],
  current: FindingRow[]
): Omit<FindingsDiff, "previousCrawlJobId" | "currentCrawlJobId"> {
  const previousByKey = new Map(previous.map((f) => [findingKey(f), f]));
  const currentByKey = new Map(current.map((f) => [findingKey(f), f]));

  const newFindings: FindingRow[] = [];
  const persistingFindings: FindingRow[] = [];
  for (const [key, f] of currentByKey) {
    if (previousByKey.has(key)) {
      persistingFindings.push(f);
    } else {
      newFindings.push(f);
    }
  }

  const resolvedFindings: FindingRow[] = [];
  for (const [key, f] of previousByKey) {
    if (!currentByKey.has(key)) {
      resolvedFindings.push(f);
    }
  }

  return { newFindings, resolvedFindings, persistingFindings };
}

/**
 * DB-backed wrapper: finds the website's two most recent COMPLETED crawl
 * jobs and diffs their findings. Returns `null` when there are fewer than
 * two completed crawls to compare (nothing to show yet).
 */
export async function computeCrawlDiff(websiteId: string): Promise<FindingsDiff | null> {
  const completedJobs = await db
    .select()
    .from(crawlJobs)
    .where(and(eq(crawlJobs.websiteId, websiteId), eq(crawlJobs.status, "completed")))
    .orderBy(desc(crawlJobs.finishedAt))
    .limit(2);

  if (completedJobs.length < 2) return null;

  const [currentJob, previousJob] = completedJobs;

  const [currentFindings, previousFindings] = await Promise.all([
    db.select().from(findings).where(eq(findings.crawlJobId, currentJob.id)),
    db.select().from(findings).where(eq(findings.crawlJobId, previousJob.id)),
  ]);

  const diff = diffFindings(previousFindings, currentFindings);

  return {
    ...diff,
    previousCrawlJobId: previousJob.id,
    currentCrawlJobId: currentJob.id,
  };
}

/** Lower rank = more severe. Exported so the notifier can pick the single highest severity among several findings. */
export const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** medium severity or higher, used by the notifier's "meaningful" threshold. */
export function isMediumOrHigher(severity: string): boolean {
  return (SEVERITY_RANK[severity] ?? 99) <= SEVERITY_RANK.medium;
}
