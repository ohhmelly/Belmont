import { describe, it, expect } from "vitest";
import { db } from "@/db";
import { websites, crawlJobs, notifications } from "@/db/app-schema";
import { createUserAndOrg, addUserToOrgWithRole } from "@/lib/test-support/auth-fixtures";
import {
  requireWebsiteAccess,
  requireCrawlJobAccess,
  requireNotificationAccess,
  requireOrgMembership,
  OrgAccessError,
} from "./require-org-access";

describe("require-org-access: real cross-org isolation", () => {
  it("denies org B access to org A's website, crawl job, and notification; allows org A's own session", async () => {
    const orgA = await createUserAndOrg("OrgA-Owner");
    const orgB = await createUserAndOrg("OrgB-Owner");

    const [website] = await db
      .insert(websites)
      .values({ organizationId: orgA.organizationId, url: "https://org-a-site.example", verificationToken: "tok-a" })
      .returning();

    const [crawlJob] = await db
      .insert(crawlJobs)
      .values({ websiteId: website.id, status: "completed", trigger: "manual" })
      .returning();

    const [notification] = await db
      .insert(notifications)
      .values({
        organizationId: orgA.organizationId,
        websiteId: website.id,
        type: "new_findings",
        severity: "high",
        title: "Test notification",
        body: "body",
      })
      .returning();

    // --- Org B (attacker) must be denied, with a 404 (not a data leak) ---
    await expect(requireWebsiteAccess(website.id, { headersOverride: orgB.headers })).rejects.toMatchObject({
      name: "OrgAccessError",
      status: 404,
    });
    await expect(requireCrawlJobAccess(crawlJob.id, { headersOverride: orgB.headers })).rejects.toMatchObject({
      name: "OrgAccessError",
      status: 404,
    });
    await expect(requireNotificationAccess(notification.id, { headersOverride: orgB.headers })).rejects.toMatchObject({
      name: "OrgAccessError",
      status: 404,
    });

    // --- Org A (legitimate owner) must be ALLOWED (positive control: the check isn't blanket-denying everyone) ---
    const aAccess = await requireWebsiteAccess(website.id, { headersOverride: orgA.headers });
    expect(aAccess.website.id).toBe(website.id);
    const aCrawl = await requireCrawlJobAccess(crawlJob.id, { headersOverride: orgA.headers });
    expect(aCrawl.crawlJob.id).toBe(crawlJob.id);
    const aNotif = await requireNotificationAccess(notification.id, { headersOverride: orgA.headers });
    expect(aNotif.notification.id).toBe(notification.id);
  });

  it("denies an insufficient role with 403 while allowing the required role", async () => {
    const orgA = await createUserAndOrg("RoleOrg-Owner");
    const member = await addUserToOrgWithRole(orgA.organizationId, "member", "RoleOrg-Member");

    await expect(requireOrgMembership(member.userId, orgA.organizationId, "owner")).rejects.toMatchObject({
      name: "OrgAccessError",
      status: 403,
    });
    const membership = await requireOrgMembership(orgA.userId, orgA.organizationId, "owner");
    expect(membership.role).toBe("owner");
  });

  it("is a real OrgAccessError instance (not a generic Error) so callers can branch on .status", async () => {
    const orgB = await createUserAndOrg("Instance-Check-OrgB");
    try {
      await requireWebsiteAccess("00000000-0000-0000-0000-000000000000", { headersOverride: orgB.headers });
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(OrgAccessError);
    }
  });
});
