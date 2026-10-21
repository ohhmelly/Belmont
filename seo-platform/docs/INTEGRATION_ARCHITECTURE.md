# Integration Architecture — Crawler Adapter (Phase 3)

Status: Phase 3 complete except where flagged "NOT VERIFIED" below. This
document describes the boundary between our app and the vendored
`siteone-crawler` binary, the common normalized finding schema both
sides map into, and exactly which checks come from which source — per
`ARCHITECTURE.md`'s decision to reuse the binary via a thin adapter
rather than reimplement a crawler.

## 1. Where the binary came from

`ARCHITECTURE.md` specified downloading a prebuilt release binary (plan
(a)) or building from source (plan (b)) as the preferred paths, falling
back to a hand-written crawler only as a last resort. In this
environment:

- Plan (a) (prebuilt GitHub release binary) was **not reachable**:
  `api.github.com` answered (200), but the `janreges/siteone-crawler`
  repository itself was not attached/authorized for this session (GitHub
  App access check), and the release-asset CDN
  (`objects.githubusercontent.com`) returned 404 through the sandbox's
  network proxy.
- Plan (b) (build from source) **worked**: the full upstream source tree
  was already present at `/home/user/janreges/siteone-crawler` in this
  sandbox. `cargo build --release` succeeded on the pinned toolchain the
  repo specifies (`rust-toolchain.toml` → Rust 1.96.0, auto-installed by
  `rustup` without further action), producing a working
  `siteone-crawler` binary (reports version `2.7.0.20260925-dev`) in
  about 4.5 minutes.
- Plan (c) (hand-written fallback crawler) was **not needed**.

The resulting binary is vendored at `vendor/siteone-crawler/` along with
its MIT `LICENSE` and a `NOTICE.md` explaining the above. It is an ELF
x86_64 binary, ~39 MB, built with the crate's default `browser` feature
enabled (so it *can* drive a real Chromium browser if one is available —
see §6).

## 2. Adapter boundary

```
src/lib/crawl-safety.ts        SSRF / network-safety pre-flight (ours, always)
src/lib/crawler-adapter.ts     orchestrates: pre-flight -> subprocess -> mapping -> supplementary pass
src/lib/supplementary-rules.ts our own rule-engine pass, for the specific gaps below
src/lib/ownership-verification.ts  meta-tag / DNS TXT ownership check
src/lib/jobs/crawl-website.ts  pg-boss job handler: DB lifecycle + findings persistence
```

`runCrawl(startUrl, options)` in `crawler-adapter.ts` is the single entry
point. It:

1. Runs `validateUrlForCrawl` (crawl-safety.ts) on the user-supplied
   start URL. The binary is **never** invoked with an unvalidated URL.
2. Invokes the binary with `--output=json` and, critically,
   `--include-regex=^https?://<validated-host>(/|$)` — scoping every
   request the binary's own queue will ever make (including anything
   reached by following a redirect) to exactly the one validated origin.
3. Parses the JSON report and maps it into our normalized schema
   (`mapSiteoneReportToFindings`).
4. Runs the supplementary rule-engine pass over the same pages, fetched
   ourselves through `safeFetch` (same pre-flight, same allowlist).

## 3. Why step 2's `--include-regex` scoping is required (not optional)

We confirmed empirically that siteone-crawler's own HTTP client does
**not** apply any SSRF/private-range check to redirect targets, and that
its default same-domain crawl restriction does not stop it from
*queuing* a redirect's target even when that target is a different
domain/IP. A real run against the fixture's `/malicious-redirect`
endpoint (302 → `http://169.254.169.254/latest/meta-data/`), with no
`--include-regex` set, produced this row in the `results` array:

```json
{"url": "http://169.254.169.254/latest/meta-data/", "status": null}
```

i.e. the crawler *attempted a real connection* to the cloud-metadata
address (it only failed because nothing is listening there in the
sandbox — on a real network this would have succeeded and leaked
whatever that address serves). Re-running the identical crawl with
`--include-regex=^https?://127\.0\.0\.1:4100/` set, the same endpoint
was crawled (we can see its 302 response and `Location` header in the
`redirects` table) but the private target was **never queued or
fetched** — confirmed by grepping the full JSON output for
`169.254.169.254` and finding it only inside the fixture page's own nav
link *text*, never as a `results` entry or a `skipped`/visited URL.

This is why `crawl-safety.ts`'s own per-hop validation (used for our
*own* fetches: ownership verification and the supplementary pass) is not
sufficient on its own — it only protects requests our Node code makes
directly. The adapter additionally must constrain the binary's own crawl
scope. Both layers are tested (`crawl-safety.test.ts`,
`crawler-adapter.test.ts`'s "SSRF" test, `crawl-website.test.ts`).

The adapter also separately inspects the binary's `redirects` table for
any redirect target that is itself a disallowed address (even one inside
the allowed scope's responses, e.g. the malicious-redirect case above)
and emits a `ssrf_blocked_redirect` / `critical` finding — this is how
the operator sees, in the findings list, that a page on the site under
audit tried to send a crawler somewhere unsafe.

## 4. Normalized finding schema

Every finding — from either source — is mapped into:

```
websiteId, crawlJobId, sourceEngine, url, canonicalUrl, httpStatus,
severity (critical|high|medium|low), category, title, description,
evidence (jsonb), discoveredAt
```

(`src/db/app-schema.ts`'s `findings` table; TS shape in
`src/lib/finding-types.ts`.)

## 5. Which checks come from which source

We inspected siteone-crawler's actual `--output=json` report structure
against the fixture site (not guessed from docs) before deciding this
split. Its JSON exposes rich site-wide tables (`seo`, `non-unique-titles`,
`non-unique-descriptions`, `404`, `redirects`, `security`, `skipped`,
etc.) and a per-URL `results` array, but it does **not** expose, for any
page: its canonical target, its hreflang alternates, or its raw HTML —
confirmed by printing every row of every table it produced and finding
no such fields anywhere in the output.

**From siteone-crawler directly** (`sourceEngine="siteone-crawler"`),
via its analyzer tables / per-URL results:

| category | severity | confirmed error or heuristic? |
|---|---|---|
| `missing_title` | critical | confirmed — a required element is absent |
| `missing_meta_description` | low | heuristic/recommendation — optional element |
| `duplicate_title` | medium | heuristic — real but not "broken" |
| `duplicate_meta_description` | low | heuristic |
| `broken_link` (404) | high | confirmed |
| `server_error` (5xx) | critical | confirmed |
| `timeout` | high | confirmed |
| `redirect_chain` (3+ hops) | medium | heuristic (works, just inefficient) |
| `redirect_loop` | high | confirmed (never reaches a destination) |

**From our own code's interpretation of siteone-crawler's redirect data**
(`sourceEngine="crawler-adapter"`):

| category | severity |
|---|---|
| `ssrf_blocked_redirect` | critical |
| `unsafe_crawl_target` (pre-flight rejected the start URL itself) | critical |

**From the supplementary rule-engine pass**
(`sourceEngine="supplementary-rules"`, `supplementary-rules.ts`) — only
for gaps verified absent from siteone-crawler's own output:

| category | severity | confirmed error or heuristic? |
|---|---|---|
| `canonical_conflict` (A→B→C never converges/loops) | high | confirmed — an objective conflict |
| `hreflang_not_reciprocal` | medium | heuristic/validation issue |
| `structured_data_invalid` (JSON-LD fails to parse) | medium | confirmed — the JSON itself is broken |
| `malformed_html` (tag-count mismatch / missing `</html>`) | medium | heuristic (a simple structural signal, not a full validator) |
| `orphan_page` (in sitemap.xml, never reached via links) | low | heuristic/informational |
| `orphan_page_summary` (rollup when orphan count exceeds the per-crawl sample cap of 25) | low | informational |

Robots.txt handling is **not** a finding category at all — it is
verified by checking that pages under a disallowed path never appear in
the findings list, while still appearing in `meta.skippedByRobots`
(siteone-crawler's own `skipped` table, reason `"Robots.txt"`). This is
asserted directly in `crawler-adapter.test.ts`.

## 6. Sitemap-based discovery

siteone-crawler's own "Sitemap options" only cover *generating* a
sitemap from a crawl, not consuming an existing one to seed discovery
(confirmed from its `--help` output — there is no flag to crawl
URLs listed in a given sitemap.xml file, only `--url=<sitemap.xml>` as
an unrelated single-shot mode we did not use). So sitemap-based
discovery is implemented in our own supplementary pass: we fetch
`robots.txt` ourselves (for its `Sitemap:` line, falling back to
`<origin>/sitemap.xml`), fetch and parse that sitemap through
`safeFetch`, and diff its URLs against the set the main crawl actually
discovered via links — which is also exactly how orphan-page detection
works. The fixture's 302-URL sitemap proved real discovery (asserted as
`meta.sitemapUrlCount >= 300` in the accuracy test) and the fixture's
dedicated `/orphan-page` (listed in the sitemap, linked from nowhere) is
asserted present among the `orphan_page` findings.

## 7. JS rendering (`--browser`) — NOT VERIFIED in this environment

siteone-crawler's `--browser` flag drives a real Chromium browser over
CDP. No Chromium-family browser is installed in this sandbox, and we did
not enable `--browser-auto-download` (a multi-hundred-MB download with
an uncertain network path, not worth the risk for this phase). A real
attempt:

```
$ siteone-crawler --url=.../js-rendered --browser ...
Crawler error: Config error: no browser found and download was not
permitted. Install Chrome/Chromium/Edge/Brave, pass --browser-path=<exe>,
or allow --browser-auto-download.
```

The adapter handles this gracefully: when `jsRendering: true` is
requested and the binary reports "no browser found", it falls back to a
static crawl and records a `jsRenderingUnavailableReason` in the job's
metadata rather than failing the whole crawl. **This fallback path and
the `--browser` flag itself are implemented but not verified against a
real Chromium in this environment.** The fixture's `/js-rendered` page
(content injected by client-side JS, invisible to a static fetch) exists
specifically to re-verify this once a Chromium-capable environment is
available — it is not asserted in the automated accuracy test for that
reason.

## 8. Ownership verification — what's real, what's a stub

Per the Phase 3 spec, this is intentionally basic but **not fake**:

- A verification token is generated per website (`generateVerificationToken`,
  `ownership-verification.ts`) and stored on the `websites` row.
- "Check meta tag now" performs a real `safeFetch` of the site's
  homepage and regex-checks for
  `<meta name="seo-platform-verification" content="<token>">`.
- "Check DNS TXT now" performs a real `dns.promises.resolveTxt` lookup of
  `_seo-platform-verify.<hostname>` and checks for the token.
- Neither path is a checkbox the user can tick themselves — both require
  the token to actually be published where we look.

**Scope decision**: a manual, one-off audit is allowed on an
**unverified** website — enqueued immediately when a website is added.
Verification is only intended to gate *scheduled/extensive* scans, which
don't exist until Phase 5 (monitoring/scheduling is explicitly out of
scope for Phase 3). This matches the task spec's own allowance ("A
manual one-off audit on an unverified site is okay to allow").

## 9. Docker build layout change

The worker image now also needs `vendor/siteone-crawler/`, a sibling of
`app/`, so `docker-compose.yml`'s `worker` service build context changed
from `./app` to the repo root (`.`), with
`dockerfile: app/Dockerfile.worker`. All `COPY` paths in
`Dockerfile.worker` were updated accordingly. **This Docker build itself
was not executed in this environment** (not in the task's required
verification list, and building/pushing a real image was out of budget
for this pass) — only the Dockerfile/compose changes were made and
reasoned through statically. The `app` service's Dockerfile/context is
unchanged (it never needs the crawler binary — only the worker crawls).
