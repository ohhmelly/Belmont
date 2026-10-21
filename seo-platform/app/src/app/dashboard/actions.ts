"use server";

import { headers } from "next/headers";
import { eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { websites, crawlJobs } from "@/db/app-schema";
import { generateVerificationToken, verifyByMetaTag, verifyByDnsTxt } from "@/lib/ownership-verification";
import { enqueueCrawl } from "@/lib/queue";
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
    .values({ websiteId: website.id, status: "pending" })
    .returning();

  await enqueueCrawl({ crawlJobId: job.id, websiteId: website.id, url: website.url });

  revalidatePath("/dashboard");
  redirect(`/dashboard/websites/${website.id}`);
}

export async function triggerCrawl(formData: FormData): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const [website] = await db.select().from(websites).where(eq(websites.id, websiteId));
  if (!website) throw new Error("Website not found");

  const [job] = await db
    .insert(crawlJobs)
    .values({ websiteId: website.id, status: "pending" })
    .returning();

  await enqueueCrawl({ crawlJobId: job.id, websiteId: website.id, url: website.url });
  revalidatePath(`/dashboard/websites/${websiteId}`);
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
