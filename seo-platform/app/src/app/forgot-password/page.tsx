"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

/**
 * Phase 7 security fix: a minimal, real password-reset request page.
 * Calls Better Auth's own `/request-password-reset` endpoint (already
 * rate-limited to 3 requests/60s per client — see src/lib/auth.ts), which
 * always replies with the same generic "if this email exists..." message
 * whether or not the account exists, so this page cannot be used to
 * enumerate registered email addresses.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error: requestError } = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
    });
    setLoading(false);
    if (requestError) {
      setError(requestError.message ?? "Could not request a password reset.");
      return;
    }
    setSubmitted(true);
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold">Reset your password</h1>
          <p className="text-sm text-foreground/60">
            Enter your account email and we&apos;ll send you a reset link if it has an SMTP server
            configured; otherwise the link is logged server-side.
          </p>
        </div>

        {submitted ? (
          <p className="text-center text-sm text-foreground/80">
            If an account exists for that email, a reset link has been sent. Check your inbox.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="email" className="text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-foreground/20 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/50"
              />
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}

        <p className="text-center text-sm text-foreground/60">
          <Link href="/login" className="font-medium underline">
            Back to log in
          </Link>
        </p>
      </div>
    </main>
  );
}
