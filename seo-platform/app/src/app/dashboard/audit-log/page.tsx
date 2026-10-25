import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { eq, desc } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { auditLog } from "@/db/app-schema";

/**
 * Basic audit log view (Phase 6). Deliberately simple — one table,
 * newest first, scoped to the caller's own organization (never another
 * org's log; this page re-derives the active org from the real session
 * the same way the dashboard home page does, it does not take an id
 * from the URL).
 */
export default async function AuditLogPage() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/login");

  const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
  const activeOrg = organizations[0] ?? null;
  if (!activeOrg) {
    return (
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12">
        <p>No organization yet.</p>
      </main>
    );
  }

  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.organizationId, activeOrg.id))
    .orderBy(desc(auditLog.createdAt))
    .limit(200);

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12 space-y-6">
      <header>
        <a href="/dashboard" className="text-sm text-foreground/60 hover:underline">
          &larr; Dashboard
        </a>
        <h1 className="mt-2 text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-foreground/60">Most recent 200 actions for {activeOrg.name}.</p>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-foreground/60">No audit events recorded yet.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-foreground/10 text-left text-foreground/50">
              <th className="py-1.5 pr-2">When</th>
              <th className="py-1.5 pr-2">Action</th>
              <th className="py-1.5 pr-2">Target</th>
              <th className="py-1.5">Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-foreground/5">
                <td className="py-1.5 pr-2 whitespace-nowrap text-foreground/60">
                  {row.createdAt.toISOString()}
                </td>
                <td className="py-1.5 pr-2 font-medium">{row.action}</td>
                <td className="py-1.5 pr-2 text-foreground/70">
                  {row.targetType ? `${row.targetType}:${(row.targetId ?? "").slice(0, 8)}` : "—"}
                </td>
                <td className="py-1.5 break-all text-foreground/50">{JSON.stringify(row.metadata)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
