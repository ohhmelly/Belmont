/**
 * Real proof that the MockBillingProvider (the DEFAULT provider when
 * STRIPE_SECRET_KEY is unset — see getBillingProvider() in index.ts)
 * exercises the full upgrade/downgrade flow end to end against a real
 * local Postgres, with no network calls and no real payment processing
 * of any kind.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/auth-schema";
import { subscriptions } from "@/db/app-schema";
import { MockBillingProvider } from "./mock-provider";

const createdOrgIds: string[] = [];
async function makeOrg(): Promise<string> {
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const orgId = `test-org-mockbilling-${uniq}`;
  await db.insert(organizations).values({ id: orgId, name: "Mock Billing Test Org", slug: orgId, createdAt: new Date() });
  createdOrgIds.push(orgId);
  return orgId;
}

afterEach(async () => {
  for (const id of createdOrgIds.splice(0)) {
    await db.delete(organizations).where(eq(organizations.id, id)).catch(() => {});
  }
});

describe("MockBillingProvider", () => {
  it("createCheckoutSession immediately flips the org onto the requested plan (no Stripe ids set)", async () => {
    const orgId = await makeOrg();
    const provider = new MockBillingProvider();

    const result = await provider.createCheckoutSession(orgId, "professional");
    expect(result.url).toContain("professional");

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    expect(row.plan).toBe("professional");
    expect(row.status).toBe("active");
    expect(row.stripeCustomerId).toBeNull();
    expect(row.stripeSubscriptionId).toBeNull();
  });

  it("supports a full upgrade then downgrade sequence", async () => {
    const orgId = await makeOrg();
    const provider = new MockBillingProvider();

    await provider.createCheckoutSession(orgId, "starter");
    let [row] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    expect(row.plan).toBe("starter");

    await provider.createCheckoutSession(orgId, "agency");
    [row] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    expect(row.plan).toBe("agency");

    await provider.createCheckoutSession(orgId, "free");
    [row] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    expect(row.plan).toBe("free");
  });

  it("createPortalSession works even for an org with no subscription row yet (lazily creates Free)", async () => {
    const orgId = await makeOrg();
    const provider = new MockBillingProvider();

    const result = await provider.createPortalSession(orgId);
    expect(result.url).toContain("/dashboard/billing");

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
    expect(row.plan).toBe("free");
  });

  it("handleWebhookEvent is a documented no-op/throw — there is no real Stripe account to send one", async () => {
    const provider = new MockBillingProvider();
    await expect(provider.handleWebhookEvent("{}", "fake-sig")).rejects.toThrow(/does not receive webhooks/);
  });
});
