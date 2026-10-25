import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/auth-schema";
import { logAudit } from "@/lib/audit/log";
import { sendEmailNotification } from "@/lib/notifications/email";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    // Use plural table names (users, sessions, organizations, members, ...)
    // to match the schema laid out for this project, instead of Better
    // Auth's singular defaults.
    usePlural: true,
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
  emailAndPassword: {
    enabled: true,
    // Stripe/email-verification are later phases; keep the bar low for now
    // so an org can be created end to end in Phase 2.
    requireEmailVerification: false,
    // Phase 7 security fix: there was previously NO password-reset path
    // at all for this SaaS — a locked-out user had no self-service way
    // back in, which is a real production gap for an email/password
    // app. Better Auth's `/request-password-reset` and `/reset-password`
    // routes already exist in the library (token generation/expiry/
    // single-use consumption all handled there) and are already covered
    // by the stricter rate-limit rule above (3/60s) — they only needed
    // this `sendResetPassword` callback wired up to actually deliver the
    // link. Reuses the same optional-SMTP `sendEmailNotification` helper
    // Phase 5's scheduled-crawl notifier already uses: with no SMTP_URL
    // configured, the reset email is a no-op (logged, never thrown) —
    // see docs/SECURITY_REVIEW.md for why a full UI/UX pass on this is
    // still a known gap, but the mechanism itself is real, not a stub.
    sendResetPassword: async ({ user, url }) => {
      await sendEmailNotification({
        to: user.email,
        subject: "Reset your AI SEO Platform password",
        text: `We received a request to reset the password for your account (${user.email}).\n\nReset it here (this link expires in 1 hour and can only be used once):\n${url}\n\nIf you didn't request this, you can safely ignore this email — your password will not change.`,
      });
    },
  },
  // Phase 7 security fix: Better Auth ships a built-in IP-keyed rate
  // limiter (src/api/rate-limiter in the library) with a strict
  // built-in rule for /sign-in and /sign-up (3 requests per 10s) plus
  // password-reset-type endpoints (3 per 60s) — exactly the brute-force
  // protection this app needs on auth endpoints, with no extra
  // dependency (in-memory by default, which is correct for this app's
  // single-instance self-hosted deployment target; no Redis needed).
  // The library only turns this on by default when NODE_ENV=production
  // (`enabled: options.rateLimit?.enabled ?? isProduction`), which is an
  // implicit, easy-to-miss dependency for something security-critical —
  // set it explicitly here so it is always on regardless of NODE_ENV.
  // Storage stays the default in-memory bucket (fine for one process;
  // see docs/SECURITY_REVIEW.md for the multi-instance/behind-proxy
  // caveats: configure `advanced.ipAddress.trustedProxies` when this app
  // sits behind a reverse proxy, otherwise every caller shares one
  // bucket per path).
  rateLimit: {
    enabled: true,
  },
  plugins: [organization()],
  // Phase 6 audit logging: a new session (sign-in or sign-up) is a
  // "login" event. Scoped to the user's first org membership, if they
  // have one yet — a session created before the user has joined/created
  // any organization has nothing to scope the log row to, so it's
  // skipped rather than written with a null organizationId.
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          try {
            const rows = await db.select().from(members).where(eq(members.userId, session.userId));
            const organizationId = rows[0]?.organizationId;
            if (!organizationId) return;
            await logAudit({
              organizationId,
              actorUserId: session.userId,
              action: "login",
              targetType: "user",
              targetId: session.userId,
            });
          } catch (err) {
            console.error("[audit] login hook failed:", err);
          }
        },
      },
    },
  },
});

export type Auth = typeof auth;
