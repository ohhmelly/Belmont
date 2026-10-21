import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { db } from "@/db";

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
});

export type Auth = typeof auth;
