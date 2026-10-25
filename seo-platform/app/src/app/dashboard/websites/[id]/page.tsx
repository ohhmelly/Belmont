import { redirect, notFound } from "next/navigation";
import {
  triggerCrawl,
  verifyWebsite,
  generateReport,
  cancelCrawl,
  setWebsiteSchedule,
  deleteWebsite,
} from "../../actions";
import { loadWebsiteDetail } from "./data";
import { OrgAccessError } from "@/lib/auth/require-org-access";

export default async function WebsiteResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // Phase 6 tenant isolation: loadWebsiteDetail re-verifies server-side
  // that the current session's organization actually owns this website
  // id — it is NOT enough that the dashboard's own website list only
  // links to the org's own sites, since any authenticated user could
  // otherwise type/guess another org's website id directly into the URL.
  let detail;
  try {
    detail = await loadWebsiteDetail(id);
  } catch (err) {
    if (err instanceof OrgAccessError) {
      if (err.status === 401) redirect("/login");
      // 403/404 both render as "not found" here — a website that
      // exists but belongs to another org must look exactly like a
      // website that doesn't exist at all, never "yes it exists, no
      // you may not see it".
      notFound();
    }
    throw err;
  }

  const {
    website,
    role,
    jobs,
    latestJob,
    siteFindings,
    latestCompletedJob,
    auditSummary,
    devTasks,
    siteReports,
    diff,
  } = detail;

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12 space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <a href="/dashboard" className="text-sm text-foreground/60 hover:underline">
            &larr; Dashboard
          </a>
          <h1 className="mt-2 text-2xl font-semibold">{website.url}</h1>
        </div>
        {(role === "owner" || role === "admin") && (
          <form action={deleteWebsite}>
            <input type="hidden" name="websiteId" value={website.id} />
            <button
              type="submit"
              className="rounded-md border border-red-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
              title="Delete this website and all its crawl history (owner/admin only)"
            >
              Delete website
            </button>
          </form>
        )}
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
        <h2 className="text-sm font-medium">Recurring audit schedule</h2>
        <p className="text-xs text-foreground/60">
          pg-boss fires a crawl automatically on this cadence (a cheap homepage staleness check and a
          minimum-interval floor can still skip an individual run — see job history below for
          &quot;scheduled&quot; entries).
        </p>
        <form action={setWebsiteSchedule} className="flex items-center gap-2">
          <input type="hidden" name="websiteId" value={website.id} />
          <select
            name="cadence"
            defaultValue={website.auditSchedule}
            className="rounded-md border border-foreground/20 bg-transparent px-2 py-1.5 text-xs"
          >
            <option value="none">No schedule</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
          <button
            type="submit"
            className="rounded-md border border-foreground/20 px-3 py-1.5 text-xs hover:bg-foreground/5"
          >
            Save schedule
          </button>
        </form>
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
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-foreground/10 text-left text-foreground/50">
                <th className="py-1.5 pr-2">Job</th>
                <th className="py-1.5 pr-2">Trigger</th>
                <th className="py-1.5 pr-2">Status</th>
                <th className="py-1.5 pr-2">Started</th>
                <th className="py-1.5 pr-2">Finished</th>
                <th className="py-1.5 pr-2">Error</th>
                <th className="py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-b border-foreground/5">
                  <td className="py-1.5 pr-2 font-mono">{job.id.slice(0, 8)}</td>
                  <td className="py-1.5 pr-2">{job.trigger}</td>
                  <td className="py-1.5 pr-2">
                    <span
                      className={
                        "rounded px-1.5 py-0.5 font-medium " +
                        (job.status === "completed"
                          ? "bg-green-100 text-green-700"
                          : job.status === "failed"
                            ? "bg-red-100 text-red-700"
                            : job.status === "cancelled"
                              ? "bg-gray-200 text-gray-600"
                              : "bg-blue-100 text-blue-700")
                      }
                    >
                      {job.status}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2 text-foreground/60">
                    {job.startedAt ? job.startedAt.toISOString() : "—"}
                  </td>
                  <td className="py-1.5 pr-2 text-foreground/60">
                    {job.finishedAt ? job.finishedAt.toISOString() : "—"}
                  </td>
                  <td className="py-1.5 pr-2 text-red-600">{job.error ?? ""}</td>
                  <td className="py-1.5">
                    {(job.status === "pending" || job.status === "running") && (
                      <form action={cancelCrawl}>
                        <input type="hidden" name="crawlJobId" value={job.id} />
                        <input type="hidden" name="websiteId" value={website.id} />
                        <button
                          type="submit"
                          className="rounded border border-red-300 px-2 py-0.5 text-red-600 hover:bg-red-50"
                        >
                          Cancel
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {diff && (
        <section className="rounded-md border border-foreground/10 p-4 space-y-3">
          <h2 className="text-sm font-medium">Change since previous crawl</h2>
          <p className="text-xs text-foreground/60">
            Comparing the two most recent completed crawls, matched by category + affected URL.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <h3 className="mb-1 text-xs font-semibold text-red-600">New ({diff.newFindings.length})</h3>
              <ul className="space-y-1 text-xs">
                {diff.newFindings.slice(0, 15).map((f) => (
                  <li key={f.id} className="text-foreground/70">
                    [{f.severity}] {f.title} — <span className="break-all">{f.url}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold text-green-600">
                Resolved ({diff.resolvedFindings.length})
              </h3>
              <ul className="space-y-1 text-xs">
                {diff.resolvedFindings.slice(0, 15).map((f) => (
                  <li key={f.id} className="text-foreground/70">
                    [{f.severity}] {f.title} — <span className="break-all">{f.url}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold text-foreground/60">
                Persisting ({diff.persistingFindings.length})
              </h3>
              <ul className="space-y-1 text-xs">
                {diff.persistingFindings.slice(0, 15).map((f) => (
                  <li key={f.id} className="text-foreground/70">
                    [{f.severity}] {f.title} — <span className="break-all">{f.url}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

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
