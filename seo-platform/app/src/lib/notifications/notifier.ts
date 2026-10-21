/**
 * Notifier abstraction (Phase 5): fires when a *scheduled* crawl completes
 * with meaningfully new issues. "Meaningful" = at least one NEW finding
 * (per the before/after diff — src/lib/findings-diff.ts) of medium
 * severity or higher, to avoid paging anyone over a stray `low` finding.
 *
 * The default, always-on path writes an in-app `notifications` row — no
 * external service required, never optional-feature-gated out. An
 * optional SMTP email rides alongside it (src/lib/notifications/email.ts)
 * and simply no-ops when `SMTP_URL` isn't set.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/app-schema";
import { members, users } from "@/db/auth-schema";
import type { FindingsDiff } from "@/lib/findings-diff";
import { SEVERITY_RANK, isMediumOrHigher } from "@/lib/findings-diff";
import { sendEmailNotification } from "./email";

export interface NotifyScheduledCrawlParams {
  organizationId: string;
  websiteId: string;
  websiteUrl: string;
  crawlJobId: string;
  diff: FindingsDiff;
}

export interface NotifyResult {
  notified: boolean;
  reason: string;
  notificationId?: string;
  email: { sent: boolean; reason?: string };
}

async function resolveNotifyRecipient(organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: users.email })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(eq(members.organizationId, organizationId))
    .limit(1);
  return row?.email ?? null;
}

/**
 * Checks the diff for meaningful new findings and, if any, writes the
 * in-app notification row and attempts the optional email send. Returns a
 * result describing exactly what happened — never throws on the email
 * leg, so a notification failure can never fail the crawl pipeline that
 * called it.
 */
export async function notifyIfMeaningful(params: NotifyScheduledCrawlParams): Promise<NotifyResult> {
  const meaningfulNew = params.diff.newFindings.filter((f) => isMediumOrHigher(f.severity));

  if (meaningfulNew.length === 0) {
    console.log(
      `[notifier] website=${params.websiteId} crawlJob=${params.crawlJobId} event=skipped reason=no_meaningful_new_findings`
    );
    return { notified: false, reason: "no_meaningful_new_findings", email: { sent: false, reason: "not_attempted" } };
  }

  const highestSeverity = [...meaningfulNew].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99)
  )[0].severity;

  const title = `${meaningfulNew.length} new issue${meaningfulNew.length === 1 ? "" : "s"} found on ${params.websiteUrl}`;
  const bulletLines = meaningfulNew
    .slice(0, 10)
    .map((f) => `- [${f.severity}] ${f.title} (${f.url})`)
    .join("\n");
  const body =
    bulletLines + (meaningfulNew.length > 10 ? `\n...and ${meaningfulNew.length - 10} more` : "");

  const [row] = await db
    .insert(notifications)
    .values({
      organizationId: params.organizationId,
      websiteId: params.websiteId,
      crawlJobId: params.crawlJobId,
      type: "new_findings",
      severity: highestSeverity,
      title,
      body,
    })
    .returning();

  console.log(
    `[notifier] website=${params.websiteId} crawlJob=${params.crawlJobId} event=notification_created id=${row.id} newCount=${meaningfulNew.length} severity=${highestSeverity}`
  );

  const recipient = await resolveNotifyRecipient(params.organizationId);
  const email = await sendEmailNotification({ to: recipient, subject: title, text: body });

  return { notified: true, reason: "meaningful_new_findings", notificationId: row.id, email };
}
