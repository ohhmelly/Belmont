import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-8 px-6 py-24 text-center">
      <div className="space-y-4">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          AI SEO Platform
        </h1>
        <p className="mx-auto max-w-xl text-base text-foreground/70">
          Self-hosted technical SEO audits, crawling, and AI-assisted
          recommendations. Phase 2 foundation: accounts, organizations, and
          the application shell.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-4">
        <Link
          href="/register"
          className="rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background transition hover:opacity-90"
        >
          Create an account
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-foreground/20 px-5 py-2.5 text-sm font-medium transition hover:bg-foreground/5"
        >
          Log in
        </Link>
      </div>
    </main>
  );
}
