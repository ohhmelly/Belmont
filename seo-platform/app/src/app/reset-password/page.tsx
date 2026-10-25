"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Phase 7 security fix: the second half of the minimal password-reset
 * flow (see /forgot-password). Better Auth's own `/reset-password/:token`
 * GET route (hit from the emailed link) validates the token and 302s
 * here with `?token=...` attached; this page just collects the new
 * password and calls the real `/reset-password` endpoint, which
 * verifies the token server-side again, enforces it is single-use and
 * not expired, and hashes the new password — none of that validation
 * happens in this component.
 */
function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("This reset link is missing its token. Request a new one.");
      return;
    }
    setLoading(true);
    const { error: resetError } = await authClient.resetPassword({ newPassword, token });
    setLoading(false);
    if (resetError) {
      setError(resetError.message ?? "Could not reset your password. The link may have expired.");
      return;
    }
    setDone(true);
    setTimeout(() => router.push("/login"), 1500);
  }

  if (!token) {
    return (
      <p className="text-center text-sm text-red-500">
        This reset link is invalid or missing its token.{" "}
        <Link href="/forgot-password" className="underline">
          Request a new one
        </Link>
        .
      </p>
    );
  }

  if (done) {
    return <p className="text-center text-sm text-foreground/80">Password updated. Redirecting to log in…</p>;
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="newPassword" className="text-sm font-medium">
          New password
        </label>
        <input
          id="newPassword"
          type="password"
          required
          minLength={8}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="w-full rounded-md border border-foreground/20 bg-transparent px-3 py-2 text-sm outline-none focus:border-foreground/50"
        />
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
      >
        {loading ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <h1 className="text-2xl font-semibold">Set a new password</h1>
        </div>
        <Suspense fallback={<p className="text-center text-sm text-foreground/60">Loading…</p>}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </main>
  );
}
