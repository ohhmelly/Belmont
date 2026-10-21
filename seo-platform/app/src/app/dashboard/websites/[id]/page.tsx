import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { eq, desc } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { websites, crawlJobs, findings, aiRecommendations, reports } from "@/db/app-schema";
import { triggerCrawl, verifyWebsite, generateReport } from "../../actions";

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export default async function WebsiteResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/login");

  const [website] = await db.select().from(websites).where(eq(websites.id, id));
  if (!website) {
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
        <p>Website not found.</p>
      </main>
    );
  }

  const jobs = await db
    .select()
    .from(crawlJobs)
    .where(eq(crawlJobs.websiteId, id))
    .orderBy(desc(crawlJobs.startedAt));

  const latestJob = jobs[0] ?? null;

  const siteFindings = latestJob
    ? await db.select().from(findings).where(eq(findings.crawlJobId, latestJob.id))
    : [];

  siteFindings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

  const latestCompletedJob = jobs.find((j) => j.status === "completed") ?? null;

  const recommendations = latestCompletedJob
    ? await db
        .select()
        .from(aiRecommendations)
        .where(eq(aiRecommendations.crawlJobId, latestCompletedJob.id))
    : [];
  const auditSummary = recommendations.find((r) => r.kind === "audit_summary") ?? null;
  const devTasks = recommendations.filter((r) => r.kind === "dev_task");

  const siteReports = latestCompletedJob
    ? await db
        .select()
        .from(reports)
        .where(eq(reports.crawlJobId, latestCompletedJob.id))
        .orderBy(desc(reports.generatedAt))
    : [];

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12 space-y-8">
      <header>
        <a href="/dashboard" className="text-sm text-foreground/60 hover:underline">
          &larr; Dashboard
        </a>
        <h1 className="mt-2 text-2xl font-semibold">{website.url}</h1>
      </header>

      <section className="rounded-md border border-foreground/10 p-4 space-y-3">
        <h2 className="text-sm font-medium">Ownership verification</h2>
        {website.verifiedAt ? (
          <p className="text-sm text-green-600">
            Verified via {website.verificationMethod} at {website.verifiedAt.toISOString()}
          </p>
        ) : (
          <div className="space-y-2 text-sm text-foreground/70">
            <p>
              Not verified yet. A manual one-off audit is still allowed; verification will be
              required before scheduled/extensive scans (a later phase).
            </p>
            <p>
              Add this meta tag to your homepage, or this DNS TXT record at{" "}
              <code>_seo-platform-verify.{new URL(website.url).hostname}</code>:
            </p>
            <pre className="overflow-x-auto rounded bg-foreground/5 p-2 text-xs">
              {`<meta name="seo-platform-verification" content="${website.verificationToken}">`}
            </pre>
            <div className="flex gap-2">
              <form action={verifyWebsite}>
                <input type="hidden" name="websiteId" value={website.id} />
                <input type="hidden" name="method" value="meta_tag" />
                <button
                  type="submit"
                  className="rounded-md border border-foreground/20 px-3 py-1.5 text-xs hover:bg-foreground/5"
                >
                  Check meta tag now
                </button>
              </form>
              <form action={verifyWebsite}>
                <input type="hidden" name="websiteId" value={website.id} />
                <input type="hidden" name="method" value="dns_txt" />
                <button
                  type="submit"
                  className="rounded-md border border-foreground/20 px-3 py-1.5 text-xs hover:bg-foreground/5"
                >
                  Check DNS TXT now
                </button>
              </form>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-md border border-foreground/10 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Crawl jobs</h2>
          <form action={triggerCrawl}>
            <input type="hidden" name="websiteId" value={website.id} />
            <button
              type="submit"
              className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90"
            >
              Run crawl
            </button>
          </form>
        </div>
        {jobs.length === 0 ? (
          <p className="text-sm text-foreground/60">No crawl jobs yet.</p>
        ) : (
          <ul className="divide-y divide-foreground/10 text-sm">
            {jobs.map((job) => (
              <li key={job.id} className="flex items-center justify-between py-2">
                <span>{job.id.slice(0, 8)}</span>
                <span className="text-foreground/60">{job.status}</span>
                {job.error ? <span className="text-red-600 text-xs">{job.error}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">
          Findings {latestJob ? `(latest crawl: ${latestJob.status})` : ""}
        </h2>
        {siteFindings.length === 0 ? (
          <p className="text-sm text-foreground/60">
            {latestJob ? "No findings for the latest crawl yet." : "No crawl has run yet."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-foreground/10 text-left text-foreground/50">
                <th className="py-2 pr-2">Severity</th>
                <th className="py-2 pr-2">Title</th>
                <th className="py-2">Affected URL</th>
              </tr>
            </thead>
            <tbody>
              {siteFindings.map((f) => (
                <tr key={f.id} className="border-b border-foreground/5">
                  <td className="py-2 pr-2">
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-xs font-medium " +
                        (f.severity === "critical"
                          ? "bg-red-100 text-red-700"
                          : f.severity === "high"
                            ? "bg-orange-100 text-orange-700"
                            : f.severity === "medium"
                              ? "bg-yellow-100 text-yellow-700"
                              : "bg-gray-100 text-gray-700")
                      }
                    >
                      {f.severity}
                    </span>
                  </td>
                  <td className="py-2 pr-2">{f.title}</td>
                  <td className="py-2 break-all text-foreground/70">{f.url}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-md border border-foreground/10 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">AI recommendations &amp; reports</h2>
          <form action={generateReport}>
            <input type="hidden" name="websiteId" value={website.id} />
            <button
              type="submit"
              disabled={!latestCompletedJob}
              className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background hover:opacity-90 disabled:opacity-40"
            >
              Generate report
            </button>
          </form>
        </div>
        {!latestCompletedJob ? (
          <p className="text-sm text-foreground/60">Run a crawl to completion first.</p>
        ) : (
          <>
            {auditSummary ? (
              <div className="rounded bg-foreground/5 p-3 text-sm space-y-1">
                <p>{auditSummary.body}</p>
                <p className="text-xs text-foreground/50">
                  Source:{" "}
                  {(auditSummary.metadata as { generatedBy?: string })?.generatedBy === "ollama"
                    ? "AI-generated (local Ollama model)"
                    : (auditSummary.metadata as { generatedBy?: string })?.generatedBy === "stub"
                      ? "placeholder (no AI model configured)"
                      : "template (AI unavailable)"}
                </p>
              </div>
            ) : (
              <p className="text-sm text-foreground/60">No AI summary yet — click &quot;Generate report&quot;.</p>
            )}

            {devTasks.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-foreground/60">Developer remediation tasks</h3>
                <ul className="list-disc pl-5 text-sm space-y-1">
                  {devTasks.map((t) => (
                    <li key={t.id}>{t.body}</li>
                  ))}
                </ul>
              </div>
            )}

            {siteReports.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-foreground/60">Downloadable reports</h3>
                <ul className="flex flex-wrap gap-2 text-sm">
                  {[...new Map(siteReports.map((r) => [r.format, r])).values()].map((r) => (
                    <li key={r.id}>
                      <a
                        href={`/api/reports/${r.id}`}
                        className="rounded-md border border-foreground/20 px-3 py-1.5 text-xs uppercase hover:bg-foreground/5"
                      >
                        {r.format} ({r.healthScore ?? "?"}/100)
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
