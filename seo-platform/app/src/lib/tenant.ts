/**
 * Tenant-isolation guards (fix for a gap flagged since Phase 4/5: every
 * dashboard server action and the report-download route trusted a
 * websiteId/reportId/notificationId straight out of form data or the URL
 * with no check that the caller's organization actually owns it. Any
 * authenticated user — from any org — could view, cancel, reschedule, or
 * download reports for any OTHER org's website by guessing or reusing a
 * UUID. These helpers are now the single place that decision is made, so
 * every call site gets it the same way.
 *
 * "Not found" is returned uniformly for both "doesn't exist" and "exists
 * but belongs to a different org", so a caller can't use the error to
 * enumerate other orgs' website/report ids.
 */
import { headers } from "next/headers";
import { eq, type InferSelectModel } from "drizzle-orm";
import { auth } from "./auth";
import { db } from "@/db";
import { websites, reports, notifications } from "@/db/app-schema";

type Website = InferSelectModel<typeof websites>;

export class TenantError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TenantError";
    this.status = status;
  }
}

/** The signed-in user's active organization id, or throws (401/403). */
export async function requireActiveOrgId(): Promise<string> {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) throw new TenantError("Not authenticated", 401);
  const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
  const activeOrg = organizations[0];
  if (!activeOrg) throw new TenantError("No organization", 403);
  return activeOrg.id;
}

/** Loads a website, or throws 404 if it doesn't exist OR belongs to a different org. */
export async function requireWebsiteInActiveOrg(websiteId: string): Promise<Website> {
  const organizationId = await requireActiveOrgId();
  const [website] = await db.select().from(websites).where(eq(websites.id, websiteId));
  if (!website || website.organizationId !== organizationId) {
    throw new TenantError("Website not found", 404);
  }
  return website;
}

/** Loads a report row, or throws 404 if it doesn't exist OR its website belongs to a different org. */
export async function requireReportInActiveOrg(reportId: string) {
  const organizationId = await requireActiveOrgId();
  const [report] = await db.select().from(reports).where(eq(reports.id, reportId));
  if (!report) throw new TenantError("Report not found", 404);
  const [website] = await db.select().from(websites).where(eq(websites.id, report.websiteId));
  if (!website || website.organizationId !== organizationId) {
    throw new TenantError("Report not found", 404);
  }
  return report;
}

/** Confirms a notification belongs to the active org before it may be mutated. */
export async function requireNotificationInActiveOrg(notificationId: string) {
  const organizationId = await requireActiveOrgId();
  const [notification] = await db.select().from(notifications).where(eq(notifications.id, notificationId));
  if (!notification || notification.organizationId !== organizationId) {
    throw new TenantError("Notification not found", 404);
  }
  return notification;
}
