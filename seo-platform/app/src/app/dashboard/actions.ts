"use server";

import { eq, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { websites, crawlJobs, notifications } from "@/db/app-schema";
import { validateUrlForCrawl, CrawlSafetyError } from "@/lib/crawl-safety";
import { generateVerificationToken, verifyByMetaTag, verifyByDnsTxt } from "@/lib/ownership-verification";
import { enqueueCrawl, applyWebsiteSchedule, cancelCrawlJob, type AuditScheduleCadence } from "@/lib/queue";
import { generateAndStoreRecommendations } from "@/lib/ai/generate-and-store";
import { generateReportsForCrawlJob, ALL_FORMATS } from "@/lib/reports/generate";
import {
  requireActiveOrg,
  requireWebsiteAccess,
  requireCrawlJobAccess,
  requireNotificationAccess,
  resolveHeaders,
  OrgAccessError,
} from "@/lib/auth/require-org-access";
import {
  assertCanAddWebsite,
  assertCanRunManualCrawl,
  assertCanSchedule,
  isAiRecommendationsAllowed,
} from "@/lib/billing/quota";
import { logAudit } from "@/lib/audit/log";
import { checkRateLimit, RateLimitError } from "@/lib/rate-limit";

/**
 * Phase 7 security fix: a per-user burst cap on manually triggering a
 * crawl, separate from (and tighter than) the monthly plan quota in
 * billing/quota.ts. The monthly quota stops someone from running more
 * crawls than their plan allows over a whole month; it does nothing to
 * stop a short burst of rapid-fire requests (each one spawning a real
 * crawler subprocess on the worker) within that same month's budget.
 * 10 manual crawl triggers per 60 seconds per user is generous for any
 * real workflow (clicking "Run crawl" repeatedly on a few sites) while
 * still bounding worst-case abuse.
 */
const MANUAL_CRAWL_BURST_MAX = 10;
const MANUAL_CRAWL_BURST_WINDOW_MS = 60_000;

function enforceManualCrawlBurstLimit(userId: string): void {
  try {
    checkRateLimit(`manual-crawl:${userId}`, MANUAL_CRAWL_BURST_MAX, MANUAL_CRAWL_BURST_WINDOW_MS);
  } catch (err) {
    if (err instanceof RateLimitError) {
      throw new Error(err.message);
    }
    throw err;
  }
}

/**
 * Phase 6 tenant-isolation fix.
 *
 * Every action below used to only check "is there a session" and then
 * act on whatever id the form posted — meaning any authenticated user
 * could act on another organization's website/crawl job just by
 * knowing its id. Every action now resolves the resource through
 * src/lib/auth/require-org-access.ts, which re-verifies server-side
 * that the CALLER's organization actually owns it (never trusting that
 * the UI only shows the user their own stuff).
 *
 * Each exported action also accepts an optional trailing
 * `headersOverride` parameter purely so tests can call the exact same
 * function with an explicit, real session's headers (see
 * src/lib/test-support/auth-fixtures.ts) instead of Next's
 * request-scoped `headers()`, which only exists inside a real Next.js
 * request and throws if called from a plain Vitest test. A `<form
 * action={...}>` only ever supplies the FormData argument, so this
 * extra parameter is inert in production and never reaches the client.
 */

/**
 * Add a website and immediately enqueue a one-off manual crawl.
 *
 * Verification scope note: per the Phase 3 spec, a manual one-off audit
 * is allowed on an unverified site — only scheduled/extensive scans
 * (Phase 5+) require verification first — so we enqueue right away and
 * show the verification token/status separately.
 *
 * Phase 6: enforces the org's plan's `maxWebsites` quota, and the
 * enqueued crawl counts toward `manualCrawlsPerMonth`. Also validates
 * the URL for SSRF-unsafe targets (private/loopback/reserved ranges)
 * BEFORE creating anything, so a plan-exceeding or structurally-unsafe
 * request never leaves a half-created website behind.
 */
export async function addWebsite(formData: FormData, headersOverride?: Headers): Promise<void> {
  const { organizationId, session } = await requireActiveOrg(headersOverride);
  const url = String(formData.get("url") ?? "").trim();
  if (!url) throw new Error("URL is required");
  new URL(url); // throws on malformed input before it ever reaches the DB/crawler

  enforceManualCrawlBurstLimit(session.userId);
  await assertCanAddWebsite(organizationId);
  await assertCanRunManualCrawl(organizationId);

  // Fail fast with a clear message instead of creating a website that is
  // structurally guaranteed to fail its first crawl: a private/loopback/
  // reserved-range target isn't a transient problem that might resolve
  // itself, so there is no reason to let it through only to surface as a
  // confusing "critical finding" after the fact (the gap this replaces).
  try {
    await validateUrlForCrawl(url);
  } catch (err) {
    if (err instanceof CrawlSafetyError) {
      throw new Error(
        `This URL can't be audited: ${err.message}. Add a publicly reachable website you control instead.`
      );
    }
    throw err;
  }

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

  await logAudit({
    organizationId,
    actorUserId: session.userId,
    action: "website_added",
    targetType: "website",
    targetId: website.id,
    metadata: { url: website.url },
  });

  revalidatePath("/dashboard");
  redirect(`/dashboard/websites/${website.id}`);
}

export async function triggerCrawl(formData: FormData, headersOverride?: Headers): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const { website, session } = await requireWebsiteAccess(websiteId, { headersOverride });

  enforceManualCrawlBurstLimit(session.userId);
  await assertCanRunManualCrawl(website.organizationId);

  const [job] = await db
    .insert(crawlJobs)
    .values({ websiteId: website.id, status: "pending", trigger: "manual" })
    .returning();

  const pgBossJobId = await enqueueCrawl({ crawlJobId: job.id, websiteId: website.id, url: website.url });
  if (pgBossJobId) {
    await db.update(crawlJobs).set({ pgBossJobId }).where(eq(crawlJobs.id, job.id));
  }

  await logAudit({
    organizationId: website.organizationId,
    actorUserId: session.userId,
    action: "crawl_triggered",
    targetType: "crawl_job",
    targetId: job.id,
    metadata: { websiteId: website.id, trigger: "manual" },
  });

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
export async function cancelCrawl(formData: FormData, headersOverride?: Headers): Promise<void> {
  const crawlJobId = String(formData.get("crawlJobId") ?? "");
  const { crawlJob: job, website, session } = await requireCrawlJobAccess(crawlJobId, { headersOverride });

  if (job.status === "pending" || job.status === "running") {
    if (job.pgBossJobId) {
      await cancelCrawlJob(job.pgBossJobId);
    }
    await db
      .update(crawlJobs)
      .set({ status: "cancelled", finishedAt: new Date(), error: "Cancelled by user" })
      .where(eq(crawlJobs.id, crawlJobId));

    await logAudit({
      organizationId: website.organizationId,
      actorUserId: session.userId,
      action: "crawl_cancelled",
      targetType: "crawl_job",
      targetId: job.id,
      metadata: { websiteId: website.id },
    });
  }
  revalidatePath(`/dashboard/websites/${website.id}`);
}

/**
 * Set/change/disable this website's recurring audit schedule. pg-boss's
 * own cron scheduler (see src/lib/queue.ts#applyWebsiteSchedule) owns
 * actually firing it; this just records the choice and (re)installs/
 * removes the pg-boss schedule entry to match.
 *
 * Phase 6: turning scheduling ON requires the org's plan to allow it
 * (`assertCanSchedule`); turning it off ("none") is always allowed.
 */
export async function setWebsiteSchedule(formData: FormData, headersOverride?: Headers): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const cadence = String(formData.get("cadence") ?? "none") as AuditScheduleCadence;
  if (!["none", "daily", "weekly", "monthly"].includes(cadence)) {
    throw new Error("Invalid cadence");
  }
  const { website, session } = await requireWebsiteAccess(websiteId, { headersOverride });

  await assertCanSchedule(website.organizationId, cadence);

  await db.update(websites).set({ auditSchedule: cadence }).where(eq(websites.id, websiteId));
  await applyWebsiteSchedule(websiteId, cadence);

  await logAudit({
    organizationId: website.organizationId,
    actorUserId: session.userId,
    action: "schedule_changed",
    targetType: "website",
    targetId: website.id,
    metadata: { cadence },
  });

  revalidatePath(`/dashboard/websites/${websiteId}`);
}

/** Mark an in-app notification (Phase 5) as read from the dashboard. Phase 6: must belong to the caller's org. */
export async function markNotificationRead(formData: FormData, headersOverride?: Headers): Promise<void> {
  const notificationId = String(formData.get("notificationId") ?? "");
  await requireNotificationAccess(notificationId, { headersOverride });
  await db.update(notifications).set({ isRead: true }).where(eq(notifications.id, notificationId));
  revalidatePath("/dashboard");
}

export async function verifyWebsite(formData: FormData, headersOverride?: Headers): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const method = String(formData.get("method") ?? "meta_tag");
  const { website } = await requireWebsiteAccess(websiteId, { headersOverride });

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
 * AND the org's plan allows AI recommendations — degrades gracefully to
 * template-based recommendations otherwise) and all four report formats
 * (PDF/HTML/CSV/JSON) for a website's most recent COMPLETED crawl job.
 * Phase 4; Phase 6 adds the ownership check and the plan gate.
 */
export async function generateReport(formData: FormData, headersOverride?: Headers): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const { website, session } = await requireWebsiteAccess(websiteId, { headersOverride });

  const [latestCompletedJob] = await db
    .select()
    .from(crawlJobs)
    .where(eq(crawlJobs.websiteId, websiteId))
    .orderBy(desc(crawlJobs.finishedAt))
    .limit(1);

  if (!latestCompletedJob || latestCompletedJob.status !== "completed") {
    throw new Error("No completed crawl job to report on yet. Run a crawl first.");
  }

  // Phase 6 plan gating: Professional/Agency get real AI-generated
  // recommendations when Ollama is configured/reachable; Free/Starter
  // always get the deterministic template instead (never nothing — see
  // GenerateAndStoreOptions in generate-and-store.ts).
  const allowAiProvider = await isAiRecommendationsAllowed(website.organizationId);
  await generateAndStoreRecommendations(latestCompletedJob.id, { allowAiProvider });
  await generateReportsForCrawlJob(latestCompletedJob.id, ALL_FORMATS);

  await logAudit({
    organizationId: website.organizationId,
    actorUserId: session.userId,
    action: "report_generated",
    targetType: "crawl_job",
    targetId: latestCompletedJob.id,
    metadata: { websiteId: website.id },
  });

  revalidatePath(`/dashboard/websites/${websiteId}`);
}

/**
 * Delete a website and everything under it (crawl jobs/findings/reports/
 * notifications cascade via FK `onDelete: "cascade"`). Phase 6: owner/
 * admin only — a plain `member` may view and crawl but not delete.
 */
export async function deleteWebsite(formData: FormData, headersOverride?: Headers): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const { website, session } = await requireWebsiteAccess(websiteId, { minRole: "admin", headersOverride });

  await db.delete(websites).where(eq(websites.id, websiteId));

  await logAudit({
    organizationId: website.organizationId,
    actorUserId: session.userId,
    action: "website_deleted",
    targetType: "website",
    targetId: website.id,
    metadata: { url: website.url },
  });

  revalidatePath("/dashboard");
  redirect("/dashboard");
}

/**
 * Invite a new member to the caller's active organization. Phase 6: the
 * role check itself is enforced by Better Auth's own `organization`
 * plugin (its default `member` role statement grants no `invitation:
 * create` permission — see node_modules/better-auth's
 * organization/access/statement.mjs) — this action just forwards to
 * `auth.api.createInvitation` (the server-side method; the client SDK
 * calls the same endpoint as `inviteMember`) with the caller's real
 * session, so a `member` gets Better Auth's own permission error, not
 * ours. See require-org-access.test.ts / role-enforcement.test.ts for
 * the proof.
 */
export async function inviteMemberAction(formData: FormData, headersOverride?: Headers): Promise<void> {
  const requestHeaders = await resolveHeaders(headersOverride);
  const { organizationId, session } = await requireActiveOrg(requestHeaders);
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "member") as "member" | "admin" | "owner";
  if (!email) throw new Error("Email is required");

  await auth.api.createInvitation({
    body: { email, role, organizationId },
    headers: requestHeaders,
  });

  await logAudit({
    organizationId,
    actorUserId: session.userId,
    action: "member_invited",
    targetType: "invitation",
    metadata: { email, role },
  });

  revalidatePath("/dashboard");
}

/**
 * Change an existing member's role. Like inviteMemberAction, the actual
 * owner/admin-only enforcement is Better Auth's own `organization`
 * plugin (`member: ["update"]` is absent from the default `member`
 * role's statement) — this just forwards to `auth.api.updateMemberRole`
 * with the caller's real session and logs it.
 */
export async function changeMemberRoleAction(formData: FormData, headersOverride?: Headers): Promise<void> {
  const requestHeaders = await resolveHeaders(headersOverride);
  const { organizationId, session } = await requireActiveOrg(requestHeaders);
  const memberId = String(formData.get("memberId") ?? "");
  const role = String(formData.get("role") ?? "member") as "member" | "admin" | "owner";
  if (!memberId) throw new Error("memberId is required");

  await auth.api.updateMemberRole({
    body: { memberId, role, organizationId },
    headers: requestHeaders,
  });

  await logAudit({
    organizationId,
    actorUserId: session.userId,
    action: "member_role_changed",
    targetType: "member",
    targetId: memberId,
    metadata: { role },
  });

  revalidatePath("/dashboard");
}

export { OrgAccessError };
