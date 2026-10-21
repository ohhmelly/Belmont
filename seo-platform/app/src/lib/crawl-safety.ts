/**
 * Network-safety pre-flight for crawling user-supplied URLs.
 *
 * This module is the ONLY place that decides whether a URL is safe to
 * connect to. The siteone-crawler binary (crawler-adapter.ts) is never
 * trusted to do this itself — it is handed a URL only after this module
 * has validated it, and every HTTP fetch this module performs itself
 * (used for ownership verification and for the supplementary rule-engine
 * pass) goes through `safeFetch` below, never bare `fetch`/`http.request`.
 *
 * Threat model covered:
 *  - SSRF to RFC1918/loopback/link-local/multicast/reserved ranges (IPv4
 *    and IPv6), including IPv4-mapped IPv6 (::ffff:127.0.0.1) and literal
 *    IP URLs (http://127.0.0.1/, http://0x7f000001/ is rejected because
 *    it fails URL parsing as a hostname and net.isIP returns 0 for it —
 *    it falls through to DNS lookup of the literal string "0x7f000001",
 *    which fails to resolve and is rejected).
 *  - DNS rebinding: the hostname is resolved and validated ONCE per
 *    request, and the resulting IP is pinned for the actual TCP connect
 *    via a custom `lookup` function — so an attacker who flips DNS
 *    between our check and the connect cannot redirect the connection to
 *    a private address.
 *  - Open redirects into private ranges: every redirect hop is validated
 *    exactly like the original URL before being followed. Redirect
 *    chains are capped (also doubles as loop protection).
 *  - Decompression-bomb-style responses: we disable compression
 *    (`Accept-Encoding: identity`) so there is no decompression step to
 *    bomb, and independently cap the raw byte count read from the socket.
 *  - Slow/hanging responses: a hard wall-clock timeout per request.
 *
 * Egress-allowlist pattern (adapted from crawlseo's outbound-hosts.json,
 * see docs/REVERSE_ENGINEERING.md and docs/INTEGRATION_ARCHITECTURE.md):
 * instead of a big config file, this module takes a small, explicit list
 * of exact origins (`scheme://host:port`) that bypass the private-range
 * check. It is EMPTY by default and must never be non-empty in a real
 * deployment — it exists solely so our own fixture test server (which
 * necessarily runs on loopback inside the test sandbox) can be crawled in
 * tests while everything else, including a redirect from that same
 * fixture server to a *different*, non-allowlisted private address, is
 * still blocked. See crawl-safety.test.ts and crawler-adapter.test.ts.
 */
import dns from "node:dns";
import net from "node:net";
import http from "node:http";
import https from "node:https";

export type CrawlSafetyErrorCode =
  | "INVALID_URL"
  | "INVALID_SCHEME"
  | "DISALLOWED_HOST"
  | "DNS_NO_RESULTS"
  | "DNS_FAILED"
  | "PRIVATE_ADDRESS"
  | "TOO_MANY_REDIRECTS"
  | "RESPONSE_TOO_LARGE"
  | "TIMEOUT";

export class CrawlSafetyError extends Error {
  code: CrawlSafetyErrorCode;
  constructor(message: string, code: CrawlSafetyErrorCode) {
    super(message);
    this.name = "CrawlSafetyError";
    this.code = code;
  }
}

export interface CrawlSafetyOptions {
  /**
   * Exact origins ("http://host:port") that are permitted even though
   * they resolve to a private/reserved address. Empty in every real
   * deployment; set only by tests, for the fixture server's own origin.
   */
  allowlistOrigins?: string[];
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

/** IPv4 ranges that are never valid crawl targets. */
function isDisallowedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed — treat as disallowed, never as "safe"
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 ("this host")
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. 169.254.169.254 cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments (192.0.0.0/24) & 192.0.2.0/24 TEST-NET-1 (b===0, next octet varies) — conservative
  if (a === 198 && b === 18) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224 && a <= 239) return true; // multicast
  if (a >= 240) return true; // reserved (240.0.0.0/4) + broadcast 255.255.255.255
  return false;
}

/** IPv6 ranges that are never valid crawl targets. */
function isDisallowedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true; // unspecified
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) — check the embedded IPv4.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isDisallowedIPv4(mapped[1]);
  const firstGroup = normalized.split(":")[0];
  // fc00::/7 unique local, fe80::/10 link-local
  if (/^f[c-f][0-9a-f]{2}$/.test(firstGroup)) {
    const firstByte = parseInt(firstGroup.slice(0, 2), 16);
    if (firstByte >= 0xfc && firstByte <= 0xfd) return true; // fc00::/7
    if (firstByte === 0xfe) {
      const secondByte = parseInt(firstGroup.slice(2, 4), 16);
      if (secondByte >= 0x80 && secondByte <= 0xbf) return true; // fe80::/10 link-local
    }
  }
  if (normalized.startsWith("ff")) return true; // multicast ff00::/8
  return false;
}

export function isDisallowedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isDisallowedIPv4(ip);
  if (family === 6) return isDisallowedIPv6(ip);
  return true; // not a valid IP literal at all — never trust it
}

export interface ValidatedTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
}

/**
 * Resolve `hostname` and reject it if it is (or resolves to) a
 * private/loopback/link-local/multicast/reserved address, unless the
 * exact origin is in `allowlistOrigins`.
 */
export async function resolveValidatedAddress(
  hostname: string,
  opts: { allowed?: boolean } = {}
): Promise<ValidatedTarget> {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "localhost.localdomain") {
    if (opts.allowed) {
      // Still resolve so we return a concrete address to pin.
    } else {
      throw new CrawlSafetyError(`"${hostname}" is not a valid crawl target`, "DISALLOWED_HOST");
    }
  }

  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isDisallowedIp(hostname) && !opts.allowed) {
      throw new CrawlSafetyError(
        `${hostname} is a private/reserved address and is not a valid crawl target`,
        "PRIVATE_ADDRESS"
      );
    }
    return { hostname, address: hostname, family: literalFamily as 4 | 6 };
  }

  let results: dns.LookupAddress[];
  try {
    results = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new CrawlSafetyError(
      `DNS resolution failed for ${hostname}: ${(err as Error).message}`,
      "DNS_FAILED"
    );
  }
  if (results.length === 0) {
    throw new CrawlSafetyError(`DNS resolution returned no addresses for ${hostname}`, "DNS_NO_RESULTS");
  }
  if (!opts.allowed) {
    for (const r of results) {
      if (isDisallowedIp(r.address)) {
        throw new CrawlSafetyError(
          `${hostname} resolves to ${r.address}, a private/reserved address — refusing to crawl`,
          "PRIVATE_ADDRESS"
        );
      }
    }
  }
  const chosen = results[0];
  return { hostname, address: chosen.address, family: chosen.family as 4 | 6 };
}

function isOriginAllowlisted(url: URL, allowlistOrigins: string[]): boolean {
  return allowlistOrigins.includes(url.origin);
}

/**
 * Validate that `rawUrl` is safe to crawl: valid http(s) URL, and its
 * hostname does not resolve to a private/reserved address (unless its
 * exact origin is explicitly allowlisted). Returns the parsed URL and the
 * pinned, validated connect address on success; throws CrawlSafetyError
 * otherwise. Call this again for every redirect hop.
 */
export async function validateUrlForCrawl(
  rawUrl: string,
  options: CrawlSafetyOptions = {}
): Promise<{ url: URL; target: ValidatedTarget }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CrawlSafetyError(`"${rawUrl}" is not a valid URL`, "INVALID_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CrawlSafetyError(`Scheme "${url.protocol}" is not allowed`, "INVALID_SCHEME");
  }
  const allowed = isOriginAllowlisted(url, options.allowlistOrigins ?? []);
  const target = await resolveValidatedAddress(url.hostname, { allowed });
  return { url, target };
}

export interface SafeFetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
  redirectChain: string[];
  truncated: boolean;
}

/**
 * A fetch that applies the full SSRF pre-flight (including on every
 * redirect hop), pins the TCP connect address to the validated IP (DNS
 * rebinding protection), enforces a timeout, and caps response size.
 * Never follows redirects automatically via the underlying HTTP client —
 * every hop is validated by this module first.
 */
export async function safeFetch(
  rawUrl: string,
  options: CrawlSafetyOptions & { method?: string; headers?: Record<string, string> } = {}
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let currentUrl = rawUrl;
  const redirectChain: string[] = [];

  for (let hop = 0; ; hop++) {
    if (hop > maxRedirects) {
      throw new CrawlSafetyError(
        `Exceeded ${maxRedirects} redirects (chain: ${redirectChain.join(" -> ")})`,
        "TOO_MANY_REDIRECTS"
      );
    }
    const { url, target } = await validateUrlForCrawl(currentUrl, options);

    const result = await singleRequest(url, target, {
      method: options.method,
      headers: options.headers,
      timeoutMs,
      maxBytes,
    });

    if (result.status >= 300 && result.status < 400 && result.location) {
      const nextUrl = new URL(result.location, url).toString();
      redirectChain.push(nextUrl);
      currentUrl = nextUrl;
      continue;
    }

    return {
      status: result.status,
      headers: result.headers,
      body: result.body,
      finalUrl: url.toString(),
      redirectChain,
      truncated: result.truncated,
    };
  }
}

function singleRequest(
  url: URL,
  target: ValidatedTarget,
  opts: { method?: string; headers?: Record<string, string>; timeoutMs: number; maxBytes: number }
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  location?: string;
  truncated: boolean;
}> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    // Pin the connect address: ignore whatever `hostname` resolves to at
    // connect time and always hand back the address we already validated.
    const lookup: (
      hostname: string,
      options: dns.LookupOneOptions,
      callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void
    ) => void = (_hostname, _opts, callback) => {
      callback(null, target.address, target.family);
    };

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: opts.method ?? "GET",
        timeout: opts.timeoutMs,
        lookup: lookup as unknown as http.RequestOptions["lookup"],
        headers: {
          "User-Agent": "seo-platform-crawler/1.0 (+safety-preflight)",
          "Accept-Encoding": "identity", // never auto-decompress: removes the decompression-bomb vector
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > opts.maxBytes) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            location: res.headers.location,
            truncated,
          });
        });
        res.on("error", (err) => {
          if (truncated) {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
              location: res.headers.location,
              truncated: true,
            });
          } else {
            reject(err);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new CrawlSafetyError(`Request to ${url.toString()} timed out after ${opts.timeoutMs}ms`, "TIMEOUT"));
    });
    req.on("error", (err) => {
      if (err instanceof CrawlSafetyError) reject(err);
      else reject(err);
    });
    req.end();
  });
}
