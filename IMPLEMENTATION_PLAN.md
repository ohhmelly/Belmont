# AI SEO Platform — Implementation Plan & Master Checklist

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked/needs decision

> **Resolved:** this repository's existing `index.html` (a "Belmont Digital"
> marketing landing page, unrelated to this project) stays untouched. The
> SEO platform is built entirely under `seo-platform/`. All deliverable docs
> (README, ARCHITECTURE, SECURITY_REVIEW, etc.) live inside `seo-platform/`
> rather than the repo root.

## Report-polish pass (2026-10-22/23, independently re-verified)

Grounded in real competitor research (CrawlRaven's public sample report,
Sitebulb/Ahrefs-style dashboards — see `docs/DESIGN_UPDATES.md`
"Competitive reference"). Delivered:
- **AI-crawler-visibility check** — a real feature gap, not just design:
  flags GPTBot/ClaudeBot/PerplexityBot/etc. blocked in robots.txt (one
  finding per blocked bot) and missing `llms.txt` (informational, low
  severity). Verified against a real fixture crawl.
- **Category score breakdown** (Technical/On-Page/Content/AI Visibility)
  using the same deduction formula as the overall score, just scoped —
  verified by hand-checking real crawl math.
- **Visual polish**: inline-SVG circular score gauge and category tiles
  in the HTML report, numbered sections (01–07), a historical-comparison
  bar chart when 2+ crawls exist — no charting library added.
- **Independently re-verified by me**, not just the implementing agent:
  `tsc`/`build` clean, full test suite (159 passed, 2 skipped) re-run
  myself, and the actual generated HTML/PDF report opened and visually
  inspected in a real browser against real crawl data — gauge, tiles,
  numbered sections, and the historical chart all render correctly with
  honest data (clean categories correctly show 100/0 findings, not
  omitted or faked).

**Separate finding while testing this (not part of the report-polish
work itself):** server actions that throw a clear, user-facing error
(the SSRF validation message, Phase 6's quota messages) render as a
cryptic "Minified React error #441" in the production build instead of
the intended message — Next.js redacts thrown-error messages on the
client in production by design. The real message IS logged server-side
(confirmed: a real `QuotaError` with its full clear text was captured in
server logs while the client only showed a digest). Fixing this properly
means converting the affected forms to return structured results
(`useActionState`) instead of throwing — a real, separate piece of work,
tracked in `REMAINING_WORK.md`, not done as part of this pass.

---

## Real-machine testing pass (2026-10-22, Windows dev machine, Remote Control)

The app was actually installed and run on a real Windows 11 development
machine (not the Linux build sandbox) for the first time, per this
project's own "Windows dev / Linux prod" requirement. This surfaced and
fixed real bugs no amount of sandbox testing would have caught:

- **Crawler didn't run at all on Windows** (vendored binary was Linux-only)
- **Tenant isolation gap** — any authenticated user could view/act on any
  other org's websites/reports by guessing a UUID (now fixed everywhere)
- SSRF-blocked crawls showed a confusing "finding" instead of failing
  fast with a clear message at add-website time
- `npm install` failed outright on a fresh clone (missing `.npmrc`,
  fixed earlier) and `npm audit` dropped from 18 vulnerabilities (1
  critical) to 9 (0 critical)
- A real process-management footgun around restarting the worker (and a
  second instance of the SAME category of bug found later, in the app
  server this time — see Phase 6 note below)

Full detail, plus what's still open, is in `REMAINING_WORK.md`. A
`docs/DESIGN_UPDATES.md` punch list was also written for the still-
not-started premium UI/UX pass (Part 3/5 of the original brief).

## Phase 0 — Housekeeping (this step)
- [x] Inspect working directory and git history
- [x] Identify conflict between existing repo content and new project scope
- [x] Write this checklist / implementation plan
- [x] Get confirmation on repo layout decision → `seo-platform/` subdirectory
- [x] Set up session TaskCreate tracking mirroring phases below

## Phase 1 — Research & Architecture ✅ COMPLETE (2026-10-21)
- [x] Inspect `IamRamgarhia/All-In-One-Free-SEO-Tool` (stack, license, activity, tests)
- [x] Inspect `janreges/siteone-crawler` (stack, license, activity, tests)
- [x] Inspect `PhialsBasement/LibreCrawl` (stack, license, activity, tests)
- [x] Inspect `StJudeWasHere/seonaut` (stack, license, activity, tests)
- [x] Inspect `crawlseo/crawlseo`
- [x] Inspect `every-app/open-seo`
- [x] Record license obligations for anything reused — all 6 are MIT; see `ARCHITECTURE.md` § License compliance
- [x] Verify documentation claims against actual source (found: LibreCrawl's "multi-tenancy" is broken — all users get `tier='admin'`; crawlseo's "AI agent ready" overstates an MCP-only integration; open-seo's self-host path is "partial" due to Cloudflare-proprietary runtime coupling)
- [x] Write `ARCHITECTURE.md` — decision: build fresh (Next.js/TS/Postgres/Drizzle/Better Auth/BullMQ), reuse siteone-crawler as subprocess, Better Auth lib, SEO rule concepts, crawlseo's egress-allowlist pattern
- [x] Write `REVERSE_ENGINEERING.md` — per-repo findings
- [x] Write `FEATURE_COMPARISON.md` — feature matrix across all 6 repos
- [ ] Write `INTEGRATION_ARCHITECTURE.md` — adapter boundaries, common crawl-result schema (moved to Phase 3, where the crawler adapter is actually built)

All docs live in `seo-platform/docs/`.

## Phase 2 — Working Application Foundation ✅ COMPLETE (2026-10-21, independently re-verified by the coordinating session, not just the implementing agent)
- [x] Scaffold chosen foundation (backend + frontend + DB) under `seo-platform/app/` — Next.js 16 App Router + TS, Postgres + Drizzle, Better Auth (email/password + `organization` plugin, Stripe deferred to Phase 6 per scope)
- [x] Docker Compose: `app`, `postgres` (healthcheck, named volume, bound to 127.0.0.1 only), `worker` (pg-boss, no Redis), `ollama` (optional, `profiles: ["ai"]`, off by default)
- [x] `.env.example` — placeholders only; verified no real secrets in `.env` (gitignored, dev-only local Postgres creds)
- [x] DB migrations: real `drizzle-kit generate` SQL migration, applied — 11 tables confirmed via `psql \dt` (`users, sessions, accounts, verifications, organizations, members, invitations, websites, crawl_jobs, findings, reports`)
- [x] Health check endpoint — re-ran myself: `curl /api/health` → `200 {"status":"ok","db":"connected"}` with Postgres up
- [x] App boots and renders — re-ran myself: `npm run build` exit 0 (7 routes, clean TS); sign-up → session cookie; org-create → `role: "owner"`; `/dashboard` (authed) → 200 rendering org name + email + "Add website"; `/dashboard` (unauthed) → 307 to `/login`

**Known gaps carried forward:** Stripe plugin deferred to Phase 6 (in scope); `npm audit` shows 8 moderate/8 high/1 critical advisories in the dependency tree — not fixed yet, flagged for a deliberate pass in Phase 7; Docker build was verified in this sandbox with a sandbox-only proxy workaround (documented by the implementing agent, not present in the committed Dockerfiles) — should be spot-checked with a plain `docker compose up --build` on the actual Linux target before going live.

## Phase 3 — Advanced Crawling ✅ COMPLETE (2026-10-21, independently re-verified)
- [x] Crawler adapter interface + versioned normalized result schema — `app/src/lib/crawler-adapter.ts`, `finding-types.ts`; boundary documented in `docs/INTEGRATION_ARCHITECTURE.md`
- [x] Integrate primary crawler engine — `siteone-crawler` built from source (`cargo build --release`, GitHub release download was unreachable from this sandbox), vendored at `seo-platform/vendor/siteone-crawler/` with LICENSE + NOTICE.md; verified `--version` → `2.7.0.20260925-dev`
- [x] SSRF/private-network/localhost/DNS-rebinding/redirect/decompression-bomb protections — `app/src/lib/crawl-safety.ts`, read and reviewed directly (not just test output): rejects RFC1918/loopback/link-local/multicast/reserved (IPv4+IPv6), pins resolved IP for the actual connect (DNS-rebinding), re-validates every redirect hop, caps response bytes, disables auto-decompression, hard timeout. **Important finding from this phase: the siteone-crawler binary itself does NOT protect against SSRF on redirects** (verified empirically — a real run reached for `169.254.169.254`); fixed by scoping every invocation with `--include-regex` to the pre-validated origin so the binary can never fetch outside it
- [x] robots.txt respect — fixture includes a disallowed path; confirmed zero findings reference it in a real crawl
- [x] Core technical SEO checks — mapped from siteone-crawler's own analyzer (titles, meta, headings, status codes, redirects, broken links, robots/sitemap) plus a supplementary pass for gaps it doesn't cover (canonical conflicts, hreflang reciprocity, JSON-LD validity, orphan pages via sitemap diffing)
- [x] Local fixture test sites with known defects — `seo-platform/fixtures/` (Express): redirect chain + loop, 404/500, duplicate/missing titles and meta descriptions, canonical conflict chain, robots.txt-disallowed path, 300-URL sitemap, malformed HTML, slow endpoint, and a malicious-redirect-to-169.254.169.254 fixture specifically to prove SSRF blocking
- [x] Automated crawler accuracy tests against fixtures — independently re-ran myself: `npx vitest run` → **63/63 passing** (3 files), against the real binary + real fixture server + real Postgres, not mocked

**Not verified / honest gaps:** JS-rendering (`--browser`) mode never actually exercised — no Chromium available in this sandbox; the binary supports it (`--browser` feature compiled in) and the adapter's fallback-to-static-crawl path runs cleanly when no browser is found, but real rendered-content detection is unverified and must be checked wherever Chromium is available (e.g. the Docker image, which bundles no browser yet either). Docker image for the `worker` service (now needs a repo-root build context to reach `vendor/`) was updated but never actually built in this phase — verify with `docker compose build worker` before relying on it. The vendored binary is committed as a ~39MB blob — acceptable for now per `NOTICE.md`'s own caveat, but should be rebuilt in a Docker build stage (or fetched as a pinned release) rather than carried in git history, before this repo is handed to anyone else to clone.

## Phase 4 — Reporting & AI ✅ COMPLETE (2026-10-21, independently re-verified)
- [x] Ollama provider integration — **real**, not stubbed: Ollama 0.5.1 installed in-session, `qwen2.5:0.5b` pulled, real round trips through `safeFetch`. App degrades gracefully to a deterministic template when AI is unavailable (tested explicitly)
- [x] AI recommendation engine tied to concrete findings — `findingIds` attached by our own code from real finding objects, never parsed from model output, so a hallucinated id is architecturally impossible (verified by reading `generate-and-store.ts`/`recommendation-engine.ts` directly)
- [x] No fabricated metrics — enforced in two independent layers: prompt-level instruction + a code-level regex guard (`violatesMetricPolicy`) that discards and replaces any AI response mentioning search volume/backlinks/ranking position/etc. **This guard exists because a real run caught a real violation** — one of 29 real recommendations from the live model mentioned "search volume" despite the system prompt forbidding it; documented transparently in `docs/AI_AND_SCORING.md` rather than hidden
- [x] Crawled content treated as untrusted data — delimited with explicit markers in the prompt; adversarial fixture page added (`/prompt-injection`, literal "Ignore previous instructions...") and run against the real model; did not fully hijack output, and grounding held regardless
- [x] Report generator: PDF (`pdfkit`, no Chromium needed)/HTML/CSV/JSON, all from one shared payload — independently re-validated every format myself: PDF signature + real page structure, CSV row count (44 = 43 findings + header), JSON health-score math checks out exactly (3 critical×8 + 4 high×4 + 6 medium×2 + 30 low×0.5 = 67 deducted → 33), HTML well-formed
- [x] Health-score calculation — documented formula in `docs/AI_AND_SCORING.md` and code comments, deterministic, explicitly not a ranking/traffic guarantee
- [x] Verified against real fixture findings — independently re-ran `npx vitest run` myself: **89/89 passing** (incl. 2 new test files, real Ollama round trips with 60s timeouts, ~4.7 min real wall-clock), `npm run build` exit 0

**Also found and fixed in this phase:** a pre-existing latent bug in Phase 3's `crawl-safety.ts` — Node 20+'s Happy-Eyeballs `autoSelectFamily` calls the custom DNS `lookup` option in a form (`{all:true}` → array callback) the code didn't handle, breaking `safeFetch` for every non-literal-IP hostname (only ever exercised with literal `127.0.0.1` fixture URLs before now). Fixed with a regression test; reviewed and confirmed sound.

**Known gaps:** report-download route reuses Phase 2/3's minimal auth bar (any authenticated session, no per-org ownership check yet) — pre-existing, flagged for Phase 6/7, not newly introduced. The small 0.5B model occasionally produces lower-quality output (echoed a delimiter token literally in 2/29 rows in one run) — a model-quality limitation, not a security issue, since no code path treats model text as anything but inert stored data.

## Phase 5 — Monitoring ✅ COMPLETE (2026-10-21, independently re-verified)
- [x] Background job system — pg-boss retry policy (`retryLimit:3, retryDelay:5, retryBackoff:true, expireInSeconds:900`), proven with real retry-then-succeed and real retry-exhaustion tests (the latter took ~90s of real backoff, not simulated)
- [x] Job cancellation — `cancelCrawl` action, pg-boss `cancel()`, and the running subprocess is actually killed via an AbortSignal threaded into `crawler-adapter.ts`'s `execFileAsync`; every terminal DB write guards `status != 'cancelled'` so a late write can never overwrite a cancellation
- [x] Persistence across restarts — **proven empirically**, not assumed: a real worker process SIGKILLed mid-crawl, confirmed stuck (`crawl_jobs` still "running", pg-boss job still "active") with no process alive, then a fresh worker started and pg-boss's own expiry/supervise mechanism retried and completed the job for real (`retryCount=1` visible in captured logs, independently re-run by me with the same result)
- [x] Scheduling (daily/weekly/monthly) — pg-boss's own `schedule()`, cron `"0 3 * * *"`/`"0 3 * * 1"`/`"0 3 1 * *"`; proven firing with a 1-minute test cron against a real spawned worker process
- [x] Configurable concurrency — `WORKER_CONCURRENCY` env var (default 2)
- [x] Job history — crawl-jobs table on the website page (status, trigger, timestamps, error), structured JSON-line lifecycle logging in the worker
- [x] Historical comparison between crawls — `findings-diff.ts`, stable key `category::url` (not finding id, which changes every crawl); proven with a real two-crawl integration test against mutated fixture content showing correct NEW/RESOLVED/PERSISTING classification
- [x] Avoid unnecessary re-crawling — two modest, documented guards on scheduled (never manual) crawls: a hard minimum interval (default 6h) regardless of cron aggressiveness, plus a conditional ETag/Last-Modified homepage check; explicitly documented as "good enough, not full incremental crawling"
- [x] Notifications (email optional/configurable) — in-app `notifications` row always written (no external dependency) when a scheduled crawl finds ≥1 new medium+ severity finding; optional SMTP via `SMTP_URL` that cleanly no-ops when unset (verified both halves: a real local SMTP catcher proved delivery works when configured, and the unset path was verified not to throw)

**Found and fixed along the way:** `pg-boss` (a Phase 3 dependency) was silently missing its `@opentelemetry/api` peer dependency — would have crashed the worker on startup the moment Phase 5's code paths actually exercised it. Added the missing dependency.

**Independently re-verified in this session:** `npx vitest run` → **112 passed, 2 skipped (114), exit 0**; `npm run build` → exit 0. The restart-recovery log sequence (worker killed → new worker resumes at `retryCount=1` → completes) was visible directly in my own re-run's output, not just the implementing agent's report.

**Known gaps:** no single combined automated test proves "a real scheduled fire → real new findings → real notification row" as one unbroken chain — each link (diffing, notifier, worker wiring) is proven real individually, not the full chain end-to-end in one test. Deleting a website with a job still queued/retrying for it leaves an orphaned pg-boss job that fails cleanly on an FK violation (a sane terminal state, not stuck, but unhandled as a distinct case) — noted, not fixed, out of this phase's explicit scope.

## Phase 6 — SaaS Features ✅ COMPLETE (2026-10-22, independently re-verified)
- [x] Auth (registration, login, password hashing, sessions) — done in Phase 2
- [x] Orgs, roles, members, tenant isolation — orgs/roles from Phase 2; the tenant-isolation *gap* found and fixed in this session's real-machine pass (see note above) is what makes this a genuine "done," not just "present"
- [x] Plans/quotas — four plans (Free/Starter/Professional/Agency) as one config object, explicitly labeled configurable placeholders, not researched pricing; real enforcement (website count, manual-crawl monthly limit, scheduling gate, AI-recommendations gate) wired into the actual `addWebsite`/`triggerCrawl`/`setWebsiteSchedule`/`generateReport` actions, not just computed and ignored
- [x] Stripe adapter in test mode — real `StripeProvider` (webhook signature verification via Stripe's own SDK, idempotency via a `processed_webhook_events` ledger) behind a `BillingProvider` interface, with a `MockBillingProvider` used automatically since no real Stripe keys exist yet (the project owner's explicit choice — this is now an internal tool, not a public SaaS, so Stripe going live is deprioritized indefinitely, not just "not done yet")
- [x] Billing explicitly stays in test mode — `StripeProvider`'s constructor refuses any key that isn't `sk_test_...` outside `NODE_ENV=test`, verified by reading the source directly

**Independently re-verified in this session:** `npx tsc --noEmit` clean, `npm run build` exit 0 (new `/dashboard/billing` and `/api/webhooks/stripe` routes present), `npx vitest run` → 141 passed, 2 skipped (Ollama, expected), 1 failed — the same pre-existing flaky test documented since before this phase (`reports/generate.test.ts:83`, confirmed unrelated, passes in isolation). Billing page confirmed rendering real, correct usage data in a live authenticated browser session (an account already over its Free-tier manual-crawl quota from earlier testing displayed correctly without crashing).

**Found and fixed along the way:** a second instance of the exact process-orphaning bug class from Phase 5/the real-machine pass — this time in `scripts/dev-stop.ps1` itself. It matched the `npm run start` wrapper's command line but not the actual `next start` child process's command line (`node .../next/dist/bin/next start`, which doesn't contain "npm run start" as a substring), so a stale pre-Phase-6 server silently kept serving the old build and returning confusing 404s for the new `/dashboard/billing` route — not a billing-code bug at all. Fixed `dev-stop.ps1` to also kill by whoever currently owns ports 3000/3001/4100, not just by command-line pattern match.

**What could not be verified:** real Stripe network calls (`createCheckoutSession`/`createPortalSession`) and a real webhook delivery from Stripe's actual servers — no real Stripe test keys exist in this environment. Signature verification and idempotency logic were verified for real using Stripe's own offline test helpers (`generateTestHeaderString`), which doesn't require a live account.

## Phase 7 — Security & QA
- [ ] Full test suite: unit, integration, API, crawler, migrations, auth, tenant isolation, reports, jobs, billing webhooks, E2E, security regressions
- [ ] Dependency vulnerability scan
- [ ] `SECURITY_REVIEW.md`
- [ ] `TEST_RESULTS.md` (only tests actually executed, with real pass/fail)

## Phase 8 — Deployment Prep
- [ ] Docker Compose finalized for Linux target (Dell server) and Windows dev
- [ ] `DEPLOYMENT.md` (setup, health checks, persistence, backup/restore, logging, restart policy, upgrade, HTTPS/reverse-proxy guidance)
- [ ] `README.md`, `CHANGELOG.md`, `REMAINING_WORK.md`

## Additional Directive — Premium UI/UX & Reverse Engineering
- [ ] Design system (color/typography/spacing/radius/elevation/motion tokens)
- [ ] Figma / 21st.dev / Playwright / Chrome DevTools / Context7 MCP — detect availability, use if present, fall back to normal tooling if not
- [ ] Motion for React (or CSS) animation pass — purposeful, `prefers-reduced-motion` respected
- [ ] One stable end-to-end slice first: URL → Crawl → Findings → Dashboard → AI → PDF report
- [ ] Visual QA pass: desktop/mobile screenshots, console errors, keyboard nav, a11y, performance profiling
- [ ] Independent review pass: security, duplication, dead code, accessibility, perf regressions

## Required Final Deliverables
- [ ] `README.md`
- [ ] `ARCHITECTURE.md`
- [ ] `IMPLEMENTATION_PLAN.md` (this file, kept current)
- [ ] `TEST_RESULTS.md`
- [ ] `SECURITY_REVIEW.md`
- [ ] `DEPLOYMENT.md`
- [ ] `CHANGELOG.md`
- [ ] `REMAINING_WORK.md`
- [ ] `REVERSE_ENGINEERING.md`
- [ ] `FEATURE_COMPARISON.md`
- [ ] `INTEGRATION_ARCHITECTURE.md`

---

## Notes
- **Scope per session**: this is a multi-week, multi-phase build. I'll work
  it in vertical slices and keep this checklist current rather than
  claiming the whole thing is done at once. I will not mark an item `[x]`
  here unless it actually runs/passes.

## Working Agreement (self-check routine)
After every phase I will, before checking items off:
1. Re-read the relevant section of the original spec.
2. Run the actual command/test and paste real output — never assume success.
3. Update this file's checkboxes to match reality, not intent.
4. Note any newly discovered work under Phase 8's `REMAINING_WORK.md`.
