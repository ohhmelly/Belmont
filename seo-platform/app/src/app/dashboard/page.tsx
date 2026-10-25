import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { eq, and, desc } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { websites, notifications } from "@/db/app-schema";
import { getMembership } from "@/lib/auth/require-org-access";
import { getUsageSummary } from "@/lib/billing/quota";
import { SignOutButton } from "./sign-out-button";
import { addWebsite, markNotificationRead, inviteMemberAction } from "./actions";

export default async function DashboardPage() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });

  if (!session) {
    redirect("/login");
  }

  const organizations = await auth.api.listOrganizations({
    headers: requestHeaders,
  });
  const activeOrg = organizations[0] ?? null;

  const orgWebsites = activeOrg
    ? await db
        .select()
        .from(websites)
        .where(eq(websites.organizationId, activeOrg.id))
    : [];

  const unreadNotifications = activeOrg
    ? await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.organizationId, activeOrg.id), eq(notifications.isRead, false)))
        .orderBy(desc(notifications.createdAt))
        .limit(10)
    : [];

  const membership = activeOrg ? await getMembership(session.user.id, activeOrg.id) : null;
  const role = membership?.role ?? null;
  const usage = activeOrg ? await getUsageSummary(activeOrg.id) : null;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <header className="mb-10 flex items-center justify-between">
        <div>
          <p className="text-sm text-foreground/60">Organization</p>
          <h1 className="text-2xl font-semibold">
            {activeOrg ? activeOrg.name : "No organization yet"}
          </h1>
        </div>
        <div className="text-right">
          <p className="text-sm">{session.user.email}</p>
          {role && <p className="text-xs text-foreground/50">Role: {role}</p>}
          <div className="mt-1 flex items-center justify-end gap-3">
            <Link href="/dashboard/billing" className="text-xs text-foreground/60 hover:underline">
              Plan &amp; billing
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>

      {usage && (
        <section className="mb-8 rounded-md border border-foreground/10 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-medium">
                Plan: {usage.plan.name}{" "}
                <span className="text-xs text-foreground/50">({usage.status})</span>
              </h2>
              <p className="mt-1 text-xs text-foreground/60">
                {usage.websiteCount}/{usage.plan.limits.maxWebsites} websites &middot;{" "}
                {usage.manualCrawlsThisMonth}/
                {usage.plan.limits.manualCrawlsPerMonth ?? "unlimited"} manual crawls this month &middot;
                scheduling {usage.plan.limits.schedulingEnabled ? "allowed" : "not on this plan"}
              </p>
            </div>
            <div className="flex gap-2 text-xs">
              <Link
                href="/dashboard/billing"
                className="rounded-md border border-foreground/20 px-3 py-1.5 hover:bg-foreground/5"
              >
                Billing
              </Link>
              <Link
                href="/dashboard/audit-log"
                className="rounded-md border border-foreground/20 px-3 py-1.5 hover:bg-foreground/5"
              >
                Audit log
              </Link>
            </div>
          </div>
        </section>
      )}

      {(role === "owner" || role === "admin") && activeOrg && (
        <section className="mb-8 rounded-md border border-foreground/10 p-4 space-y-2">
          <h2 className="text-sm font-medium">Invite a member</h2>
          <p className="text-xs text-foreground/60">
            Owner/admin only — a plain &quot;member&quot; cannot invite, change billing, or delete websites,
            only view findings/reports and trigger manual crawls.
          </p>
          <form action={inviteMemberAction} className="flex flex-wrap gap-2">
            <input
              type="email"
              name="email"
              required
              placeholder="teammate@example.com"
              className="min-w-0 flex-1 rounded-md border border-foreground/20 bg-transparent px-3 py-2 text-sm"
            />
            <select
              name="role"
              defaultValue="member"
              className="rounded-md border border-foreground/20 bg-transparent px-2 py-2 text-sm"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="submit"
              className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
            >
              Invite
            </button>
          </form>
        </section>
      )}

      {unreadNotifications.length > 0 && (
        <section className="mb-8 space-y-2 rounded-md border border-amber-300/40 bg-amber-50/50 p-4 dark:bg-amber-950/20">
          <h2 className="text-sm font-medium">Notifications</h2>
          <ul className="space-y-2 text-sm">
            {unreadNotifications.map((n) => (
              <li key={n.id} className="flex items-start justify-between gap-3 rounded bg-background/50 p-2">
                <div>
                  <p className="font-medium">{n.title}</p>
                  <p className="whitespace-pre-line text-xs text-foreground/60">{n.body}</p>
                  <p className="text-xs text-foreground/40">{n.createdAt.toISOString()}</p>
                </div>
                <form action={markNotificationRead}>
                  <input type="hidden" name="notificationId" value={n.id} />
                  <button type="submit" className="whitespace-nowrap rounded border border-foreground/20 px-2 py-1 text-xs hover:bg-foreground/5">
                    Mark read
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Websites</h2>
        </div>

        <form action={addWebsite} className="flex gap-2">
          <input
            type="url"
            name="url"
            required
            placeholder="https://example.com"
            className="flex-1 rounded-md border border-foreground/20 bg-transparent px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90"
          >
            Add website
          </button>
        </form>

        {orgWebsites.length === 0 ? (
          <div className="rounded-md border border-dashed border-foreground/20 px-6 py-10 text-center text-sm text-foreground/60">
            No websites yet. Add one above to start crawling and auditing it
            — a crawl is enqueued automatically.
          </div>
        ) : (
          <ul className="divide-y divide-foreground/10 rounded-md border border-foreground/10">
            {orgWebsites.map((site) => (
              <li key={site.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <Link href={`/dashboard/websites/${site.id}`} className="hover:underline">
                  {site.url}
                </Link>
                <span className="text-xs text-foreground/50">
                  {site.verifiedAt ? "Verified" : "Unverified"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
