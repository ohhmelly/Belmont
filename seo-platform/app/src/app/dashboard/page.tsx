import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { websites } from "@/db/app-schema";
import { SignOutButton } from "./sign-out-button";
import { addWebsite } from "./actions";

export default async function DashboardPage() {
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });

  if (!session) {
    redirect("/login");
  }

  const organizations = await auth.api.listOrganizations({
    headers: requestHeaders,
  });
  const activeOrg = organizations[0] ?? null;

  const orgWebsites = activeOrg
    ? await db
        .select()
        .from(websites)
        .where(eq(websites.organizationId, activeOrg.id))
    : [];

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <header className="mb-10 flex items-center justify-between">
        <div>
          <p className="text-sm text-foreground/60">Organization</p>
          <h1 className="text-2xl font-semibold">
            {activeOrg ? activeOrg.name : "No organization yet"}
          </h1>
        </div>
        <div className="text-right">
          <p className="text-sm">{session.user.email}</p>
          <SignOutButton />
        </div>
      </header>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Websites</h2>
        </div>

        <form action={addWebsite} className="flex gap-2">
          <input
            type="url"
            name="url"
            required
            placeholder="https://example.com"
            className="flex-1 rounded-md border border-foreground/20 bg-transparent px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition hover:opacity-90"
          >
            Add website
          </button>
        </form>

        {orgWebsites.length === 0 ? (
          <div className="rounded-md border border-dashed border-foreground/20 px-6 py-10 text-center text-sm text-foreground/60">
            No websites yet. Add one above to start crawling and auditing it
            — a crawl is enqueued automatically.
          </div>
        ) : (
          <ul className="divide-y divide-foreground/10 rounded-md border border-foreground/10">
            {orgWebsites.map((site) => (
              <li key={site.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <Link href={`/dashboard/websites/${site.id}`} className="hover:underline">
                  {site.url}
                </Link>
                <span className="text-xs text-foreground/50">
                  {site.verifiedAt ? "Verified" : "Unverified"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
