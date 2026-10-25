/**
 * Data loading for the website results page, pulled out of page.tsx so
 * the Phase 6 ownership check it performs can be exercised directly by
 * a test with an explicit session's headers (a React Server Component
 * can't take extra constructor args — only `params`/`searchParams` —
 * so the check has to live in a plain function the page calls, not
 * inline in the component).
 */
import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { crawlJobs, findings, aiRecommendations, reports } from "@/db/app-schema";
import { computeCrawlDiff } from "@/lib/findings-diff";
import { requireWebsiteAccess, type OrgRole } from "@/lib/auth/require-org-access";

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export async function loadWebsiteDetail(websiteId: string, headersOverride?: Headers) {
  // Throws OrgAccessError(401/404) if there's no session, or the
  // session's org does not own this website — callers (the page
  // component) turn a 404 into Next's notFound().
  const { website, membership } = await requireWebsiteAccess(websiteId, { headersOverride });

  const jobs = await db
    .select()
    .from(crawlJobs)
    .where(eq(crawlJobs.websiteId, websiteId))
    .orderBy(desc(crawlJobs.startedAt));

  const latestJob = jobs[0] ?? null;

  const siteFindings = latestJob
    ? await db.select().from(findings).where(eq(findings.crawlJobId, latestJob.id))
    : [];
  siteFindings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  const latestCompletedJob = jobs.find((j) => j.status === "completed") ?? null;

  const recommendations = latestCompletedJob
    ? await db.select().from(aiRecommendations).where(eq(aiRecommendations.crawlJobId, latestCompletedJob.id))
    : [];
  const auditSummary = recommendations.find((r) => r.kind === "audit_summary") ?? null;
  const devTasks = recommendations.filter((r) => r.kind === "dev_task");

  const siteReports = latestCompletedJob
    ? await db
        .select()
        .from(reports)
        .where(eq(reports.crawlJobId, latestCompletedJob.id))
        .orderBy(desc(reports.generatedAt))
    : [];

  const diff = await computeCrawlDiff(website.id);

  return {
    website,
    role: membership.role as OrgRole,
    jobs,
    latestJob,
    siteFindings,
    latestCompletedJob,
    auditSummary,
    devTasks,
    siteReports,
    diff,
  };
}

export type WebsiteDetail = Awaited<ReturnType<typeof loadWebsiteDetail>>;
