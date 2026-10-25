import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/auth-schema";
import { logAudit } from "@/lib/audit/log";

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
