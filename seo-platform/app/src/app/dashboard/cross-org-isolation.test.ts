/**
 * THE single most important test added in Phase 6: a real adversarial
 * proof that tenant isolation actually works across the full set of
 * call sites the spec names — the website detail page's data loader,
 * the server actions (cancel crawl, trigger crawl, generate report,
 * delete website), and the report-download Route Handler.
 *
 * Everything here is real: two real organizations and two real users
 * created through the real Better Auth sign-up/org-create flow (see
 * src/lib/test-support/auth-fixtures.ts), a real Postgres database, and
 * the exact exported production functions — `loadWebsiteDetail`,
 * `cancelCrawl`, `triggerCrawl`, `generateReport`, `deleteWebsite`, and
 * the reports route's `GET` — called with org B's real session cookie
 * against org A's real resources. Nothing about authorization is
 * mocked or stubbed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { websites, crawlJobs, reports } from "@/db/app-schema";
import { createUserAndOrg, type TestUserAndOrg } from "@/lib/test-support/auth-fixtures";
import { loadWebsiteDetail } from "./websites/[id]/data";
import { cancelCrawl, triggerCrawl, generateReport, deleteWebsite } from "./actions";
import { OrgAccessError } from "@/lib/auth/require-org-access";
import { reportsStorageRoot } from "@/lib/reports/generate";
import { GET as downloadReport } from "@/app/api/reports/[id]/route";

describe("Phase 6 cross-org isolation (adversarial, real DB + real sessions)", () => {
  let orgA: TestUserAndOrg;
  let orgB: TestUserAndOrg;
  let websiteId: string;
  let crawlJobId: string;
  let reportId: string;

  beforeAll(async () => {
    orgA = await createUserAndOrg("IsoOrgA-Owner");
    orgB = await createUserAndOrg("IsoOrgB-Owner");

    const [website] = await db
      .insert(websites)
      .values({ organizationId: orgA.organizationId, url: "https://org-a-only.example", verificationToken: "iso-tok-a" })
      .returning();
    websiteId = website.id;

    const [job] = await db
      .insert(crawlJobs)
      .values({ websiteId, status: "completed", trigger: "manual", finishedAt: new Date() })
      .returning();
    crawlJobId = job.id;

    // A real report FILE on disk, exactly like generateReportsForCrawlJob
    // would write, so the download route genuinely streams real bytes
    // when access is (correctly) allowed, and genuinely must not when
    // it isn't.
    const relPath = path.join(websiteId, `${crawlJobId}.json`);
    const absPath = path.join(reportsStorageRoot(), relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, JSON.stringify({ secret: "org A's confidential SEO report" }), "utf8");

    const [report] = await db
      .insert(reports)
      .values({ websiteId, crawlJobId, format: "json", healthScore: 77, filePath: relPath })
      .returning();
    reportId = report.id;
  }, 30_000);

  it("denies org B's data loader for org A's website page (404, not the data)", async () => {
    await expect(loadWebsiteDetail(websiteId, orgB.headers)).rejects.toMatchObject({
      name: "OrgAccessError",
      status: 404,
    });
    // Positive control: org A itself can load its own page.
    const detail = await loadWebsiteDetail(websiteId, orgA.headers);
    expect(detail.website.id).toBe(websiteId);
  });

  it("denies org B cancelling org A's crawl job", async () => {
    const formData = new FormData();
    formData.set("crawlJobId", crawlJobId);
    formData.set("websiteId", websiteId);

    await expect(cancelCrawl(formData, orgB.headers)).rejects.toBeInstanceOf(OrgAccessError);

    // The job must be untouched by the attempted cross-org cancel.
    const [job] = await db.select().from(crawlJobs).where(eq(crawlJobs.id, crawlJobId));
    expect(job.status).toBe("completed");
  });

  it("denies org B triggering a manual crawl on org A's website", async () => {
    const formData = new FormData();
    formData.set("websiteId", websiteId);
    await expect(triggerCrawl(formData, orgB.headers)).rejects.toBeInstanceOf(OrgAccessError);
  });

  it("denies org B generating a report for org A's website", async () => {
    const formData = new FormData();
    formData.set("websiteId", websiteId);
    await expect(generateReport(formData, orgB.headers)).rejects.toBeInstanceOf(OrgAccessError);
  });

  it("denies org B deleting org A's website", async () => {
    const formData = new FormData();
    formData.set("websiteId", websiteId);
    await expect(deleteWebsite(formData, orgB.headers)).rejects.toBeInstanceOf(OrgAccessError);

    // The website must still exist, owned by org A, after the attempt.
    const [stillThere] = await db.select().from(websites).where(eq(websites.id, websiteId));
    expect(stillThere).toBeTruthy();
    expect(stillThere.organizationId).toBe(orgA.organizationId);
  });

  it("denies org B downloading org A's report via the real Route Handler (403/404, no bytes leaked), and allows org A", async () => {
    const reqB = new NextRequest(`http://localhost:3000/api/reports/${reportId}`, {
      headers: orgB.headers,
    });
    const resB = await downloadReport(reqB, { params: Promise.resolve({ id: reportId }) });
    expect([403, 404]).toContain(resB.status);
    const bodyB = await resB.text();
    expect(bodyB).not.toContain("secret");
    expect(bodyB).not.toContain("org A's confidential");

    // Positive control: org A's own session can download it, and gets
    // the real bytes.
    const reqA = new NextRequest(`http://localhost:3000/api/reports/${reportId}`, {
      headers: orgA.headers,
    });
    const resA = await downloadReport(reqA, { params: Promise.resolve({ id: reportId }) });
    expect(resA.status).toBe(200);
    const bodyA = await resA.text();
    expect(bodyA).toContain("org A's confidential SEO report");
  });

  it("rejects an unauthenticated request to the same report entirely", async () => {
    const reqAnon = new NextRequest(`http://localhost:3000/api/reports/${reportId}`);
    const resAnon = await downloadReport(reqAnon, { params: Promise.resolve({ id: reportId }) });
    expect(resAnon.status).toBe(401);
  });
});
