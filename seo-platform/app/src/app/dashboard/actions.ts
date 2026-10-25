"use server";

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
import {
  requireActiveOrg,
  requireWebsiteAccess,
  requireCrawlJobAccess,
  requireNotificationAccess,
  resolveHeaders,
  OrgAccessError,
} from "@/lib/auth/require-org-access";
import { assertCanAddWebsite, assertCanTriggerManualCrawl, assertSchedulingAllowed } from "@/lib/plans/quota";
import { getOrgPlan } from "@/lib/plans/limits";
import { logAudit } from "@/lib/audit/log";

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
 * enqueued crawl counts toward `maxManualCrawlsPerMonth`.
 */
export async function addWebsite(formData: FormData, headersOverride?: Headers): Promise<void> {
  const { organizationId, session } = await requireActiveOrg(headersOverride);
  const url = String(formData.get("url") ?? "").trim();
  if (!url) throw new Error("URL is required");
  new URL(url); // throws on malformed input before it ever reaches the DB/crawler

  await assertCanAddWebsite(organizationId);
  await assertCanTriggerManualCrawl(organizationId);

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

  await assertCanTriggerManualCrawl(website.organizationId);

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
 * (`schedulingAllowed`); turning it off ("none") is always allowed.
 */
export async function setWebsiteSchedule(formData: FormData, headersOverride?: Headers): Promise<void> {
  const websiteId = String(formData.get("websiteId") ?? "");
  const cadence = String(formData.get("cadence") ?? "none") as AuditScheduleCadence;
  if (!["none", "daily", "weekly", "monthly"].includes(cadence)) {
    throw new Error("Invalid cadence");
  }
  const { website } = await requireWebsiteAccess(websiteId, { headersOverride });

  if (cadence !== "none") {
    await assertSchedulingAllowed(website.organizationId);
  }

  await db.update(websites).set({ auditSchedule: cadence }).where(eq(websites.id, websiteId));
  await applyWebsiteSchedule(websiteId, cadence);

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

  const { limits } = await getOrgPlan(website.organizationId);
  if (limits.aiRecommendationsAllowed) {
    await generateAndStoreRecommendations(latestCompletedJob.id);
  }
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
 * Start a Stripe Checkout session for the caller's org to subscribe to a
 * paid plan. Phase 6: owner/admin only ("change billing/plan" is a
 * higher-privilege action, same bucket as inviting members or deleting
 * the org). TEST MODE ONLY — see src/lib/billing/stripe-client.ts; if
 * `STRIPE_SECRET_KEY`/the plan's price id aren't configured in this
 * environment, this throws a clear error rather than silently doing
 * nothing (there is no live Stripe account wired up in this sandbox —
 * see the Phase 6 completion report for exactly what was and wasn't
 * verified against a real Stripe API).
 */
export async function createCheckoutSessionAction(formData: FormData, headersOverride?: Headers): Promise<void> {
  const { organizationId } = await requireActiveOrg(headersOverride, "admin");
  const plan = String(formData.get("plan") ?? "");
  const priceEnvKey =
    plan === "starter"
      ? "STRIPE_PRICE_STARTER"
      : plan === "professional"
        ? "STRIPE_PRICE_PROFESSIONAL"
        : plan === "agency"
          ? "STRIPE_PRICE_AGENCY"
          : null;
  if (!priceEnvKey) throw new Error(`Unknown plan "${plan}"`);
  const priceId = process.env[priceEnvKey];
  if (!priceId) {
    throw new Error(
      `${priceEnvKey} is not configured in this environment. Stripe checkout is TEST MODE ONLY and needs a test-mode price id — see .env.example.`
    );
  }

  const { getStripeClient } = await import("@/lib/billing/stripe-client");
  const stripe = getStripeClient();
  const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const checkoutSession = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: organizationId,
    metadata: { organizationId },
    subscription_data: { metadata: { organizationId } },
    success_url: `${baseUrl}/dashboard/billing?checkout=success`,
    cancel_url: `${baseUrl}/dashboard/billing?checkout=cancelled`,
  });

  if (!checkoutSession.url) throw new Error("Stripe did not return a checkout URL");
  redirect(checkoutSession.url);
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
