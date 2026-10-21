"use server";

import { headers } from "next/headers";
import { eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { websites, crawlJobs, notifications } from "@/db/app-schema";
import { generateVerificationToken, verifyByMetaTag, verifyByDnsTxt } from "@/lib/ownership-verification";
import { enqueueCrawl, applyWebsiteSchedule, cancelCrawlJob, type AuditScheduleCadence } from "@/lib/queue";
import { generateAndStoreRecommendations } from "@/lib/ai/generate-and-store";
import { generateReportsForCrawlJob, ALL_FORMATS } from "@/lib/reports/generate";

async function requireActiveOrgId(): Promise<string> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) throw new Error("Not authenticated");
  const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
  const activeOrg = organizations[0];
  if (!activeOrg) throw new Error("No organization");
  return activeOrg.id;
}

/**
 * Add a website and immediately enqueue a one-off manual crawl.
 *
 * Verification scope note: per the Phase 3 spec, a manual one-off audit
 * is allowed on an unverified site — only scheduled/extensive scans
 * (Phase 5+) require verification first — so we enqueue right away and
 * show the verification token/status separately.
 */
export async function addWebsite(formData: FormData): Promise<void> {
  const organizationId = await requireActiveOrgId();
  const url = String(formData.get("url") ?? "").trim();
  if (!url) throw new Error("URL is required");
  new URL(url); // throws on malformed input before it ever reaches the DB/crawler

  const token = generateVerificationToken();
  const [website] = await db
    .insert(websites)
    .values({ organizationId, url, verificationToken: token })
    .returning();

  const [job] = await db
    .insert(crawlJobs)
    .values({ websiteId: website.id, status: "pending", trigger: "manual" })
    .returning();

  const pgBossJobId = await enqueueCrawl({ crawlJobId: job.id, websiteId: website.id, url: website.url });
  if (pgBossJobId) {
    await db.update(crawlJobs).set({ pgBossJobId }).where(eq(crawlJobs.id, job.id));
  }

  revalidatePath("/dashboard");
  redirect(`/dashboard/websites/${website.id}`);
}

export async function triggerCrawl(formData: FormData): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const [website] = await db.select().from(websites).where(eq(websites.id, websiteId));
  if (!website) throw new Error("Website not found");

  const [job] = await db
    .insert(crawlJobs)
    .values({ websiteId: website.id, status: "pending", trigger: "manual" })
    .returning();

  const pgBossJobId = await enqueueCrawl({ crawlJobId: job.id, websiteId: website.id, url: website.url });
  if (pgBossJobId) {
    await db.update(crawlJobs).set({ pgBossJobId }).where(eq(crawlJobs.id, job.id));
  }
  revalidatePath(`/dashboard/websites/${websiteId}`);
}

/**
 * Cancel a crawl job that is still pending or running. Tells pg-boss to
 * cancel the underlying job (if we recorded its id — a job created before
 * this field existed won't have one) and marks the `crawl_jobs` row
 * cancelled ourselves immediately, since a pending job has no worker
 * around to notice the cancellation on its own, and an active job's
 * handler may not race-check in time to update the DB before this request
 * returns.
 */
export async function cancelCrawl(formData: FormData): Promise<void> {
  const crawlJobId = String(formData.get("crawlJobId") ?? "");
  const websiteId = String(formData.get("websiteId") ?? "");
  const [job] = await db.select().from(crawlJobs).where(eq(crawlJobs.id, crawlJobId));
  if (!job) throw new Error("Crawl job not found");

  if (job.status === "pending" || job.status === "running") {
    if (job.pgBossJobId) {
      await cancelCrawlJob(job.pgBossJobId);
    }
    await db
      .update(crawlJobs)
      .set({ status: "cancelled", finishedAt: new Date(), error: "Cancelled by user" })
      .where(eq(crawlJobs.id, crawlJobId));
  }
  revalidatePath(`/dashboard/websites/${websiteId}`);
}

/**
 * Set/change/disable this website's recurring audit schedule. pg-boss's
 * own cron scheduler (see src/lib/queue.ts#applyWebsiteSchedule) owns
 * actually firing it; this just records the choice and (re)installs/
 * removes the pg-boss schedule entry to match.
 */
export async function setWebsiteSchedule(formData: FormData): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const cadence = String(formData.get("cadence") ?? "none") as AuditScheduleCadence;
  if (!["none", "daily", "weekly", "monthly"].includes(cadence)) {
    throw new Error("Invalid cadence");
  }
  const [website] = await db.select().from(websites).where(eq(websites.id, websiteId));
  if (!website) throw new Error("Website not found");

  await db.update(websites).set({ auditSchedule: cadence }).where(eq(websites.id, websiteId));
  await applyWebsiteSchedule(websiteId, cadence);

  revalidatePath(`/dashboard/websites/${websiteId}`);
}

/** Mark an in-app notification (Phase 5) as read from the dashboard. */
export async function markNotificationRead(formData: FormData): Promise<void> {
  const notificationId = String(formData.get("notificationId") ?? "");
  await db.update(notifications).set({ isRead: true }).where(eq(notifications.id, notificationId));
  revalidatePath("/dashboard");
}

export async function verifyWebsite(formData: FormData): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const method = String(formData.get("method") ?? "meta_tag");
  const [website] = await db.select().from(websites).where(eq(websites.id, websiteId));
  if (!website) throw new Error("Website not found");

  const result =
    method === "dns_txt"
      ? await verifyByDnsTxt(new URL(website.url).hostname, website.verificationToken)
      : await verifyByMetaTag(website.url, website.verificationToken);

  if (result.verified) {
    await db
      .update(websites)
      .set({ verifiedAt: new Date(), verificationMethod: result.method })
      .where(eq(websites.id, websiteId));
  }

  revalidatePath(`/dashboard/websites/${websiteId}`);
}

/**
 * Generate AI recommendations (if an AI provider is configured/reachable
 * — degrades gracefully to template-based recommendations otherwise) and
 * all four report formats (PDF/HTML/CSV/JSON) for a website's most
 * recent COMPLETED crawl job. Phase 4.
 */
export async function generateReport(formData: FormData): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const [website] = await db.select().from(websites).where(eq(websites.id, websiteId));
  if (!website) throw new Error("Website not found");

  const [latestCompletedJob] = await db
    .select()
    .from(crawlJobs)
    .where(eq(crawlJobs.websiteId, websiteId))
    .orderBy(desc(crawlJobs.finishedAt))
    .limit(1);

  if (!latestCompletedJob || latestCompletedJob.status !== "completed") {
    throw new Error("No completed crawl job to report on yet. Run a crawl first.");
  }

  await generateAndStoreRecommendations(latestCompletedJob.id);
  await generateReportsForCrawlJob(latestCompletedJob.id, ALL_FORMATS);

  revalidatePath(`/dashboard/websites/${websiteId}`);
}
