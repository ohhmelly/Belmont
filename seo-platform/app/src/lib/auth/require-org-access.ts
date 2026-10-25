/**
 * Tenant-isolation / role-authorization helper (Phase 6).
 *
 * Before this module existed, every dashboard page, server action and API
 * route in this app checked only "is there a logged-in session" — never
 * "does this user's organization actually own this website/crawl job/
 * report/notification". Any authenticated user could view, cancel or
 * download another organization's data by guessing/knowing an id. This
 * module is the single place that fix lives, so every call site uses the
 * exact same check instead of ad-hoc copies.
 *
 * Design notes:
 *  - `requireSession`/the `requireXAccess` functions all take an optional
 *    `headersOverride`. Production call sites (Server Components, Server
 *    Actions, Route Handlers) call them with no override, which falls back
 *    to Next's request-scoped `headers()`. Tests — which run under Vitest,
 *    outside any Next.js request — call the exact same functions with an
 *    explicit `Headers` object built from a real Better Auth session
 *    (see src/lib/test-support/auth-fixtures.ts), so the authorization
 *    logic under test is byte-for-byte what production runs, just not
 *    wrapped in an HTTP socket.
 *  - A resource that exists but belongs to a different org, and a
 *    resource that doesn't exist at all, both come back as 404
 *    ("not found") rather than 403 ("forbidden") — this avoids confirming
 *    to an attacker that a given id exists but belongs to someone else.
 *    A 403 is used only when the resource IS in the caller's own org but
 *    their role is too low for the specific action (e.g. a `member`
 *    trying an owner/admin-only action).
 */
import { headers as nextHeaders } from "next/headers";
import { eq, and } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { members } from "@/db/auth-schema";
import { websites, crawlJobs, reports, notifications } from "@/db/app-schema";

export type OrgRole = "owner" | "admin" | "member";

const ROLE_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

export function roleAtLeast(role: string, min: OrgRole): boolean {
  const rank = ROLE_RANK[role as OrgRole];
  return rank !== undefined && rank >= ROLE_RANK[min];
}

export class OrgAccessError extends Error {
  readonly status: 401 | 403 | 404;
  constructor(message: string, status: 401 | 403 | 404) {
    super(message);
    this.name = "OrgAccessError";
    this.status = status;
  }
}

export interface SessionContext {
  userId: string;
  userEmail: string;
  session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>["session"];
  user: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>["user"];
}

/** Resolve the request headers to use: an explicit override (tests) or Next's real request-scoped headers (production). */
export async function resolveHeaders(headersOverride?: Headers): Promise<Headers> {
  if (headersOverride) return headersOverride;
  return await nextHeaders();
}

/** Require a logged-in Better Auth session. Throws OrgAccessError(401) if absent. */
export async function requireSession(headersOverride?: Headers): Promise<SessionContext> {
  const requestHeaders = await resolveHeaders(headersOverride);
  const result = await auth.api.getSession({ headers: requestHeaders });
  if (!result) throw new OrgAccessError("Not authenticated", 401);
  return {
    userId: result.user.id,
    userEmail: result.user.email,
    session: result.session,
    user: result.user,
  };
}

export interface Membership {
  role: OrgRole;
  organizationId: string;
}

/** Look up the caller's membership row in a specific organization (not "any org"). Returns null if they are not a member. */
export async function getMembership(userId: string, organizationId: string): Promise<Membership | null> {
  const rows = await db
    .select()
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, organizationId)));
  const found = rows[0];
  if (!found) return null;
  return { role: found.role as OrgRole, organizationId };
}

/**
 * Require that `userId` belongs to `organizationId`, optionally with at
 * least `minRole`. Throws 404 if not a member at all (resource looks
 * nonexistent to an outsider), 403 if a member but under-privileged.
 */
export async function requireOrgMembership(
  userId: string,
  organizationId: string,
  minRole?: OrgRole
): Promise<Membership> {
  const membership = await getMembership(userId, organizationId);
  if (!membership) {
    throw new OrgAccessError("Not found", 404);
  }
  if (minRole && !roleAtLeast(membership.role, minRole)) {
    throw new OrgAccessError(
      `This action requires the '${minRole}' role or higher; you are a '${membership.role}'.`,
      403
    );
  }
  return membership;
}

export interface WebsiteAccess {
  website: typeof websites.$inferSelect;
  session: SessionContext;
  membership: Membership;
}

/** Require the caller's session to belong to the org that owns this website. */
export async function requireWebsiteAccess(
  websiteId: string,
  opts: { minRole?: OrgRole; headersOverride?: Headers } = {}
): Promise<WebsiteAccess> {
  const session = await requireSession(opts.headersOverride);
  const [website] = await db.select().from(websites).where(eq(websites.id, websiteId));
  if (!website) throw new OrgAccessError("Website not found", 404);
  const membership = await requireOrgMembership(session.userId, website.organizationId, opts.minRole);
  return { website, session, membership };
}

export interface CrawlJobAccess extends WebsiteAccess {
  crawlJob: typeof crawlJobs.$inferSelect;
}

/** Require the caller's session to belong to the org that owns this crawl job (resolved via its website). */
export async function requireCrawlJobAccess(
  crawlJobId: string,
  opts: { minRole?: OrgRole; headersOverride?: Headers } = {}
): Promise<CrawlJobAccess> {
  const session = await requireSession(opts.headersOverride);
  const [crawlJob] = await db.select().from(crawlJobs).where(eq(crawlJobs.id, crawlJobId));
  if (!crawlJob) throw new OrgAccessError("Crawl job not found", 404);
  const [website] = await db.select().from(websites).where(eq(websites.id, crawlJob.websiteId));
  if (!website) throw new OrgAccessError("Crawl job not found", 404);
  const membership = await requireOrgMembership(session.userId, website.organizationId, opts.minRole);
  return { website, crawlJob, session, membership };
}

export interface ReportAccess extends WebsiteAccess {
  report: typeof reports.$inferSelect;
}

/** Require the caller's session to belong to the org that owns this report (resolved via its website). */
export async function requireReportAccess(
  reportId: string,
  opts: { minRole?: OrgRole; headersOverride?: Headers } = {}
): Promise<ReportAccess> {
  const session = await requireSession(opts.headersOverride);
  const [report] = await db.select().from(reports).where(eq(reports.id, reportId));
  if (!report) throw new OrgAccessError("Report not found", 404);
  const [website] = await db.select().from(websites).where(eq(websites.id, report.websiteId));
  if (!website) throw new OrgAccessError("Report not found", 404);
  const membership = await requireOrgMembership(session.userId, website.organizationId, opts.minRole);
  return { website, report, session, membership };
}

export interface NotificationAccess {
  notification: typeof notifications.$inferSelect;
  session: SessionContext;
  membership: Membership;
}

/** Require the caller's session to belong to the org a notification was written for. */
export async function requireNotificationAccess(
  notificationId: string,
  opts: { minRole?: OrgRole; headersOverride?: Headers } = {}
): Promise<NotificationAccess> {
  const session = await requireSession(opts.headersOverride);
  const [notification] = await db.select().from(notifications).where(eq(notifications.id, notificationId));
  if (!notification) throw new OrgAccessError("Notification not found", 404);
  const membership = await requireOrgMembership(session.userId, notification.organizationId, opts.minRole);
  return { notification, session, membership };
}

/**
 * Resolve the caller's "active" organization for actions that create a
 * new resource (e.g. adding a website) rather than looking one up by id.
 * Mirrors the pre-Phase-6 `requireActiveOrgId` but also returns the
 * caller's role in it, and is explicit that "active" here means "first
 * org returned for this user" (this app does not yet have an org
 * switcher UI — see dashboard/page.tsx).
 */
export async function requireActiveOrg(
  headersOverride?: Headers,
  minRole?: OrgRole
): Promise<{ organizationId: string; role: OrgRole; session: SessionContext }> {
  const requestHeaders = await resolveHeaders(headersOverride);
  const session = await requireSession(requestHeaders);
  const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
  const activeOrg = organizations[0];
  if (!activeOrg) throw new OrgAccessError("No organization", 404);
  const membership = await requireOrgMembership(session.userId, activeOrg.id, minRole);
  return { organizationId: activeOrg.id, role: membership.role, session };
}
