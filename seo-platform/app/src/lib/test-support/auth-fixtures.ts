/**
 * Test helper: create REAL users/organizations through the REAL Better
 * Auth sign-up/org-create flow (same `auth` instance the app uses, same
 * Postgres), and hand back a `Headers` object carrying that user's real
 * session cookie so authorization tests can call production code paths
 * exactly as a real logged-in request would, just without an actual
 * Next.js HTTP server in front of it (see the header comment on
 * src/lib/auth/require-org-access.ts for why that's necessary and why
 * it's still a real, not mocked, test).
 */
import { auth } from "@/lib/auth";

export interface TestUserAndOrg {
  userId: string;
  email: string;
  organizationId: string;
  organizationSlug: string;
  /** Real session cookie header for this user, usable with auth.api.getSession / any requireXAccess helper's headersOverride. */
  headers: Headers;
}

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

function cookieHeaderFrom(setHeaders: Headers): string {
  const setCookie = setHeaders.getSetCookie ? setHeaders.getSetCookie() : [setHeaders.get("set-cookie") ?? ""];
  return setCookie
    .filter(Boolean)
    .map((c) => c.split(";")[0])
    .join("; ");
}

/** Sign up a brand-new real user (owner) and create a brand-new real organization for them. */
export async function createUserAndOrg(label: string): Promise<TestUserAndOrg> {
  const email = `${unique(label)}@example.test`;
  const signUp = (await auth.api.signUpEmail({
    body: { email, password: "test-password-123456", name: label },
    returnHeaders: true,
  })) as { response: { user: { id: string } }; headers: Headers };

  const cookieHeader = cookieHeaderFrom(signUp.headers);
  const headers = new Headers({ cookie: cookieHeader });

  const slug = unique(`org-${label}`).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const org = (await auth.api.createOrganization({
    body: { name: `${label} Org`, slug },
    headers,
  })) as { id: string; slug: string } | null;
  if (!org) throw new Error("createOrganization returned null in test fixture");

  return {
    userId: signUp.response.user.id,
    email,
    organizationId: org.id,
    organizationSlug: org.slug,
    headers,
  };
}

/**
 * Sign up a second real user and add them to an existing organization
 * with a given role, bypassing the invite-email flow via Better Auth's
 * server-only `addMember` API (meant for exactly this: trusted
 * server-side membership management). Returns that user's own real
 * session headers.
 */
export async function addUserToOrgWithRole(
  organizationId: string,
  role: "owner" | "admin" | "member",
  label: string
): Promise<{ userId: string; email: string; headers: Headers }> {
  const email = `${unique(label)}@example.test`;
  const signUp = (await auth.api.signUpEmail({
    body: { email, password: "test-password-123456", name: label },
    returnHeaders: true,
  })) as { response: { user: { id: string } }; headers: Headers };

  const cookieHeader = cookieHeaderFrom(signUp.headers);
  const headers = new Headers({ cookie: cookieHeader });

  await auth.api.addMember({
    body: { userId: signUp.response.user.id, role, organizationId },
  });

  return { userId: signUp.response.user.id, email, headers };
}
