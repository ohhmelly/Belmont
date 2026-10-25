/**
 * Audit logging (Phase 6). One small helper, called at the meaningful
 * points listed in the spec (login, website added/deleted, crawl
 * triggered/cancelled, report generated/downloaded, plan/billing
 * changed, member invited/role changed) — deliberately not an elaborate
 * framework: a single `logAudit()` call per site, writing one row to
 * `audit_log`.
 *
 * Logging is best-effort: a failure to write an audit row must never
 * break the actual user-facing action it's describing, so errors are
 * caught and logged to the server console rather than rethrown.
 */
import { db } from "@/db";
import { auditLog } from "@/db/app-schema";

export type AuditAction =
  | "login"
  | "website_added"
  | "website_deleted"
  | "crawl_triggered"
  | "crawl_cancelled"
  | "schedule_changed"
  | "report_generated"
  | "report_downloaded"
  | "plan_changed"
  | "member_invited"
  | "member_role_changed";

export interface AuditEntry {
  organizationId: string;
  actorUserId?: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      organizationId: entry.organizationId,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? {},
    });
  } catch (err) {
    console.error("[audit] failed to write audit log entry:", entry.action, err);
  }
}
