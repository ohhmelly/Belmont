/**
 * Website ownership verification (Phase 3).
 *
 * Real, if basic, checks — NOT a checkbox the user ticks themselves:
 *  - meta-tag method: we fetch the website's homepage ourselves (through
 *    the same SSRF-safe `safeFetch`) and look for
 *    `<meta name="seo-platform-verification" content="<token>">`.
 *  - DNS TXT method: we look up `_seo-platform-verify.<hostname>` TXT
 *    records ourselves and check for the token.
 *
 * Scope note (see docs/INTEGRATION_ARCHITECTURE.md): per the Phase 3
 * spec, a manual one-off audit is allowed on an UNVERIFIED site —
 * verification is only required before scheduled/extensive scans, which
 * don't exist until Phase 5. So `verifiedAt` is informational/gating for
 * future phases, not a precondition enforced by the crawl job itself yet.
 */
import dns from "node:dns";
import crypto from "node:crypto";
import { safeFetch, type CrawlSafetyOptions } from "./crawl-safety";

export function generateVerificationToken(): string {
  return `seoplatform-verify-${crypto.randomBytes(20).toString("hex")}`;
}

export interface VerificationResult {
  verified: boolean;
  method: "meta_tag" | "dns_txt";
  checkedAt: Date;
  detail: string;
}

export async function verifyByMetaTag(
  siteUrl: string,
  token: string,
  safety: CrawlSafetyOptions = {}
): Promise<VerificationResult> {
  try {
    const result = await safeFetch(siteUrl, safety);
    const html = result.body.toString("utf8");
    const re = new RegExp(
      `<meta[^>]+name=["']seo-platform-verification["'][^>]+content=["']${token}["']`,
      "i"
    );
    const reReversed = new RegExp(
      `<meta[^>]+content=["']${token}["'][^>]+name=["']seo-platform-verification["']`,
      "i"
    );
    const found = re.test(html) || reReversed.test(html);
    return {
      verified: found,
      method: "meta_tag",
      checkedAt: new Date(),
      detail: found
        ? `Found matching <meta name="seo-platform-verification"> tag on ${result.finalUrl}.`
        : `Fetched ${result.finalUrl} (HTTP ${result.status}) but did not find a matching verification meta tag.`,
    };
  } catch (err) {
    return {
      verified: false,
      method: "meta_tag",
      checkedAt: new Date(),
      detail: `Could not fetch ${siteUrl}: ${(err as Error).message}`,
    };
  }
}

export async function verifyByDnsTxt(hostname: string, token: string): Promise<VerificationResult> {
  const recordName = `_seo-platform-verify.${hostname}`;
  try {
    const records = await dns.promises.resolveTxt(recordName);
    const flat = records.map((chunks) => chunks.join(""));
    const found = flat.some((v) => v.includes(token));
    return {
      verified: found,
      method: "dns_txt",
      checkedAt: new Date(),
      detail: found
        ? `Found matching TXT record at ${recordName}.`
        : `Looked up ${recordName} and found ${flat.length} TXT record(s), none matching the expected token.`,
    };
  } catch (err) {
    return {
      verified: false,
      method: "dns_txt",
      checkedAt: new Date(),
      detail: `DNS TXT lookup for ${recordName} failed: ${(err as Error).message}`,
    };
  }
}
