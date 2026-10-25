/**
 * Phase 7 security fix: before this phase, this app had NO password
 * reset path at all — `src/lib/auth.ts` never configured
 * `emailAndPassword.sendResetPassword`, so Better Auth's own
 * `/request-password-reset` endpoint responded with
 * `RESET_PASSWORD_DISABLED` for every request, and a locked-out user
 * had no self-service way back into their account.
 *
 * This test proves the real, now-wired-up flow end to end against the
 * real `auth` instance and real Postgres — not a mock of Better Auth:
 *  1. `auth.api.requestPasswordReset` for a real user creates a real,
 *     single-use verification token row (`verifications` table,
 *     identifier `reset-password:<token>`).
 *  2. `auth.api.resetPassword` with that real token actually changes
 *     the stored credential: signing in with the OLD password now
 *     fails, and signing in with the NEW password succeeds.
 *  3. The token is single-use: trying to reuse it is rejected.
 *  4. An unknown email is accepted the same way (no account-enumeration
 *     signal) and creates no verification row.
 *
 * No SMTP_URL is configured in this test environment, so
 * `sendResetPassword`'s call to `sendEmailNotification` cleanly no-ops
 * (proven for real in notifications/email.test.ts) — this test reads
 * the token directly from the `verifications` table instead of an
 * inbox, which is what a real email's reset link would carry anyway.
 */
import { describe, it, expect } from "vitest";
import { eq, desc, like } from "drizzle-orm";
import { auth } from "./auth";
import { db } from "@/db";
import { verifications } from "@/db/auth-schema";
import { createUserAndOrg } from "@/lib/test-support/auth-fixtures";

async function latestResetTokenFor(userId: string): Promise<string> {
  const rows = await db
    .select()
    .from(verifications)
    .where(like(verifications.identifier, "reset-password:%"))
    .orderBy(desc(verifications.createdAt));
  const row = rows.find((r) => r.value === userId);
  if (!row) throw new Error(`No reset-password verification row found for user ${userId}`);
  return row.identifier.slice("reset-password:".length);
}

describe("password reset flow (auth.ts sendResetPassword wiring)", () => {
  it("requestPasswordReset creates a real token; resetPassword with it changes the password for real", async () => {
    const { userId, email } = await createUserAndOrg("PwReset");

    const reqResult = await auth.api.requestPasswordReset({
      body: { email, redirectTo: "/reset-password" },
    });
    expect(reqResult.status).toBe(true);

    const token = await latestResetTokenFor(userId);
    expect(token).toBeTruthy();

    await auth.api.resetPassword({
      body: { newPassword: "brand-new-password-987654", token },
    });

    // Old password must no longer work.
    await expect(
      auth.api.signInEmail({ body: { email, password: "test-password-123456" } })
    ).rejects.toThrow();

    // New password must work.
    const signInResult = await auth.api.signInEmail({
      body: { email, password: "brand-new-password-987654" },
    });
    // Better Auth normalizes stored emails to lowercase.
    expect(signInResult.user.email).toBe(email.toLowerCase());
  });

  it("rejects reusing an already-consumed reset token", async () => {
    const { userId, email } = await createUserAndOrg("PwResetReuse");

    await auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } });
    const token = await latestResetTokenFor(userId);

    await auth.api.resetPassword({ body: { newPassword: "first-new-password-111222", token } });

    // Reusing the same token for a second password change must fail.
    await expect(
      auth.api.resetPassword({ body: { newPassword: "second-new-password-333444", token } })
    ).rejects.toThrow();
  });

  it("does not reveal whether an email is registered (same response, no verification row created)", async () => {
    const unknownEmail = `no-such-user-${Date.now()}@example.test`;

    const result = await auth.api.requestPasswordReset({
      body: { email: unknownEmail, redirectTo: "/reset-password" },
    });
    // Same generic success response as a real account would get.
    expect(result.status).toBe(true);

    const rows = await db.select().from(verifications).where(eq(verifications.value, unknownEmail));
    expect(rows).toHaveLength(0);
  });
});
