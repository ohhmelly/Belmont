"use client";

/**
 * Error boundary for the whole /dashboard subtree (Phase 6).
 *
 * Before this existed, a server action throwing a clear, user-facing
 * Error (the SSRF pre-flight message added in the tenant-isolation fix,
 * and now the plan/quota-exceeded messages from src/lib/billing/quota.ts)
 * surfaced as Next.js's generic unstyled error overlay/page instead of
 * being shown as plain text in context — the message was always correct
 * and complete, just not presented well. This renders that same
 * `error.message` in the page instead, with a way back, rather than
 * changing what any action throws.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <div className="space-y-4 rounded-md border border-red-300/40 bg-red-50/50 p-6 dark:bg-red-950/20">
        <h1 className="text-lg font-semibold text-red-700 dark:text-red-400">
          This didn&apos;t go through
        </h1>
        <p className="text-sm text-foreground/80">{error.message}</p>
        <div className="flex gap-3">
          <button
            onClick={() => reset()}
            className="rounded-md border border-foreground/20 px-3 py-1.5 text-sm hover:bg-foreground/5"
          >
            Try again
          </button>
          <a
            href="/dashboard"
            className="rounded-md border border-foreground/20 px-3 py-1.5 text-sm hover:bg-foreground/5"
          >
            Back to dashboard
          </a>
        </div>
      </div>
    </main>
  );
}
