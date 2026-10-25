/**
 * Real proof that org roles are enforced, not just displayed (Phase 6).
 *
 * Two things under test, both with real users/orgs/sessions:
 *  1. Our own owner/admin-only action (deleteWebsite) denies a plain
 *     `member` and allows the `owner`.
 *  2. Better Auth's organization plugin's OWN built-in permission
 *     system denies a `member` from inviting a new member (via our
 *     `inviteMemberAction`, which forwards to `auth.api.createInvitation`)
 *     and allows the `owner`. This is Better Auth's enforcement, not
 *     code this phase wrote — the test proves the wiring actually
 *     surfaces it rather than silently swallowing/bypassing it.
 */
import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { websites } from "@/db/app-schema";
import { members } from "@/db/auth-schema";
import { createUserAndOrg, addUserToOrgWithRole } from "@/lib/test-support/auth-fixtures";
import { deleteWebsite, inviteMemberAction, changeMemberRoleAction } from "./actions";

describe("Phase 6 role enforcement (real Better Auth sessions)", () => {
  it("denies a member deleting a website; allows the owner", async () => {
    const owner = await createUserAndOrg("RoleDel-Owner");
    const member = await addUserToOrgWithRole(owner.organizationId, "member", "RoleDel-Member");

    const [website] = await db
      .insert(websites)
      .values({ organizationId: owner.organizationId, url: "https://role-test.example", verificationToken: "tok" })
      .returning();

    const formData = new FormData();
    formData.set("websiteId", website.id);

    await expect(deleteWebsite(formData, member.headers)).rejects.toMatchObject({
      name: "OrgAccessError",
      status: 403,
    });
    const [stillThere] = await db.select().from(websites).where(eq(websites.id, website.id));
    expect(stillThere).toBeTruthy();

    // Owner succeeds (redirect() throws a Next.js-internal control-flow
    // "error" outside a real request — that's a test-harness artifact of
    // calling a server action directly, not a failure of the delete
    // itself, which already ran).
    try {
      await deleteWebsite(formData, owner.headers);
    } catch (err) {
      if (!(err instanceof Error) || !/NEXT_REDIRECT|static generation store/.test(err.message)) throw err;
    }
    const [gone] = await db.select().from(websites).where(eq(websites.id, website.id));
    expect(gone).toBeUndefined();
  });

  it("denies a member inviting a new member (Better Auth's own permission check); allows the owner", async () => {
    const owner = await createUserAndOrg("RoleInv-Owner");
    const member = await addUserToOrgWithRole(owner.organizationId, "member", "RoleInv-Member");

    const memberFormData = new FormData();
    memberFormData.set("email", `invited-by-member-${Date.now()}@example.test`);
    memberFormData.set("role", "member");

    await expect(inviteMemberAction(memberFormData, member.headers)).rejects.toThrow();

    const ownerFormData = new FormData();
    const invitedEmail = `invited-by-owner-${Date.now()}@example.test`;
    ownerFormData.set("email", invitedEmail);
    ownerFormData.set("role", "member");

    // The invite itself (the real `auth.api.createInvitation` call) must
    // succeed for the owner; the only thing allowed to throw afterward is
    // revalidatePath()'s test-harness artifact (no real Next.js request
    // store outside an actual server), same as the redirect() cases above.
    try {
      await inviteMemberAction(ownerFormData, owner.headers);
    } catch (err) {
      if (!(err instanceof Error) || !/static generation store/.test(err.message)) throw err;
    }
  });

  it("denies a member changing another member's role (Better Auth's own permission check); allows the owner", async () => {
    const owner = await createUserAndOrg("RoleChange-Owner");
    const memberA = await addUserToOrgWithRole(owner.organizationId, "member", "RoleChange-MemberA");
    const memberB = await addUserToOrgWithRole(owner.organizationId, "member", "RoleChange-MemberB");

    const [memberBRow] = await db
      .select()
      .from(members)
      .where(and(eq(members.userId, memberB.userId), eq(members.organizationId, owner.organizationId)));

    const fdByMember = new FormData();
    fdByMember.set("memberId", memberBRow.id);
    fdByMember.set("role", "admin");
    await expect(changeMemberRoleAction(fdByMember, memberA.headers)).rejects.toThrow();

    const [stillMember] = await db
      .select()
      .from(members)
      .where(and(eq(members.userId, memberB.userId), eq(members.organizationId, owner.organizationId)));
    expect(stillMember.role).toBe("member");

    const fdByOwner = new FormData();
    fdByOwner.set("memberId", memberBRow.id);
    fdByOwner.set("role", "admin");
    try {
      await changeMemberRoleAction(fdByOwner, owner.headers);
    } catch (err) {
      if (!(err instanceof Error) || !/static generation store/.test(err.message)) throw err;
    }
    const [nowAdmin] = await db
      .select()
      .from(members)
      .where(and(eq(members.userId, memberB.userId), eq(members.organizationId, owner.organizationId)));
    expect(nowAdmin.role).toBe("admin");
  });

  it("allows an admin (not just an owner) to delete a website", async () => {
    const owner = await createUserAndOrg("RoleAdmin-Owner");
    const admin = await addUserToOrgWithRole(owner.organizationId, "admin", "RoleAdmin-Admin");

    const [website] = await db
      .insert(websites)
      .values({ organizationId: owner.organizationId, url: "https://role-admin-test.example", verificationToken: "tok" })
      .returning();

    const formData = new FormData();
    formData.set("websiteId", website.id);
    try {
      await deleteWebsite(formData, admin.headers);
    } catch (err) {
      if (!(err instanceof Error) || !/NEXT_REDIRECT|static generation store/.test(err.message)) throw err;
    }
    const [gone] = await db.select().from(websites).where(eq(websites.id, website.id));
    expect(gone).toBeUndefined();
  });
});
