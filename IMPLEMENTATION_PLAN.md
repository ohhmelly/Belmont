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

## Phase 6 — SaaS Features ✅ COMPLETE (2026-10-25, reconciled from two parallel implementations, independently re-verified)

**Important process note:** partway through this phase, a second Claude Code session — started separately by the project owner, apparently on their own Windows machine — was independently doing its own Phase 6 work on this same branch and pushing to the same remote, with no awareness of this session's parallel work. Both sessions built real, tested, working implementations of tenant isolation and billing before either knew about the other. Nothing was lost: both full histories exist in git (this session's Phase 6 commit is `db9bd0e`; the other session's four commits run `cf1f54d`..`30b39ca`). Rather than discard either side, the two were reconciled deliberately (merge commit `624cb8b`): the other session's branch was adopted as the base — it was more complete on billing (a proper `BillingProvider` interface with a `MockBillingProvider` default, matching the spec's explicit "implement a development mock... rather than blocking the rest of development" requirement) and added real work this session had none of at all (Windows crawler binary support, report-generation polish, SSRF validation at add-time instead of only after a blocked crawl) — and this session's two genuine value-adds that the other branch lacked entirely were ported onto it: role-based (owner/admin-only) authorization enforcement, and audit logging.

- [x] Auth (registration, login, password hashing, sessions) — done in Phase 2
- [x] **Tenant isolation — the critical fix, from either session's independent discovery of the same gap.** The reconciled codebase uses this session's `src/lib/auth/require-org-access.ts` as the sole canonical authorization module (the other session's equivalent, `tenant.ts`, was deleted after confirming every call site was rewired) because it's a strict superset: role-based `minRole` gating, which the other session's version lacked entirely. **Proven post-merge, not just pre-merge**: `cross-org-isolation.test.ts` imports directly from the live, reconciled `./actions` module and was re-run against the final merged code — 404/403 denial confirmed on every call site (website page, cancel/trigger crawl, generate report, delete website) with positive controls proving the legitimate org still works
- [x] Org roles enforced — `member` denied owner/admin-only actions (`deleteWebsite` carries `minRole: "admin"`, confirmed by reading the final merged `actions.ts` directly), proven with a real test
- [x] Plans/quotas — the other session's four-plan system (Free/Starter/Professional/Agency, explicitly labeled configurable placeholders derived from the spec's own words, not researched pricing), with real enforcement (website count, monthly manual-crawl limit, scheduling gate, AI-recommendations gate) wired into `addWebsite`/`triggerCrawl`/`setWebsiteSchedule`/`generateReport` — kept as the sole billing/quota system; this session's parallel, independently-built `org_plans`/`plans/quota.ts` system was discarded in favor of it (functionally comparable, but the kept version had the mock-provider pattern this session's lacked)
- [x] Stripe adapter in test mode — the other session's `StripeProvider` behind a `BillingProvider` interface, real webhook signature verification via Stripe's own SDK, idempotency via a `processed_webhook_events` ledger, `MockBillingProvider` used automatically with no real Stripe keys configured. Its live-key guard is confirmed **stricter** than this session's independently-built equivalent (which it replaced): an allowlist requiring `sk_test_...` exactly, vs. this session's blocklist of `sk_live_`/`rk_live_` — read directly in `stripe-provider.ts` and confirmed by its own test
- [x] Billing explicitly stays in test mode — verified directly in source, not just documentation
- [x] Audit logging — this session's `audit_log` table + `src/lib/audit/log.ts`, which the other session's branch had no equivalent for at all; ported onto the merged `actions.ts` at 9 call sites (website added/deleted, crawl triggered/cancelled, report generated, schedule changed, plan changed, member invited/role changed) — confirmed by reading the final file directly, not just the reconciliation report

**Also newly present from the other session's independent work, now merged in:** Windows crawler binary support (`vendor/siteone-crawler-windows/`, platform-picked in `crawler-adapter.ts`), report-generation polish (category-level scoring, HTML/PDF improvements), SSRF validation moved to add-website time (fixing the UX rough edge flagged earlier in this document — a crawl target is now rejected immediately when added, not surfaced as a "critical finding" after a wasted crawl attempt), competitive SEO-report-design research (`docs/DESIGN_UPDATES.md`), and PowerShell dev-start/dev-stop scripts for Windows.

**Independently re-verified in this session, on the final reconciled code (not pre-merge):** confirmed `tenant.ts` and this session's superseded billing/plan files no longer exist on disk; confirmed the final Postgres schema has exactly the other session's billing tables (`subscriptions`, `processed_webhook_events`) plus this session's `audit_log`, with no leftover `org_plans`/`stripe_events` (`psql \dt`); confirmed `deleteWebsite`'s `minRole: "admin"` gating and all 9 `logAudit` call sites by reading `actions.ts` directly; confirmed the Stripe live-key guard by reading `stripe-provider.ts` directly; confirmed `cross-org-isolation.test.ts` imports the live `./actions` module, not a stale copy. `npx vitest run` → **173 passed, 2 skipped (175), exit 0**. `npm run build` → exit 0, all routes from both sessions present (`/api/webhooks/stripe`, `/dashboard/billing`, `/dashboard/audit-log`).

**Known gaps (carried from both sides, neither superseded the other on these):** no live/test Stripe account was ever exercised against the real Stripe API in either session — only offline signature verification was proven. No org-switcher UI — "active org" is still "first org returned for this user."

## Phase 7 — Security & QA ✅ COMPLETE (2026-10-25, independently re-verified)
- [x] Full test suite — 30 files, 191 passed, 2 skipped (Ollama-dependent, confirmed honestly unreachable in this sandbox, not swept under the rug), 0 failed
- [x] Dependency vulnerability scan — real before/after: 5 (4 moderate, 1 high) → 4 (all moderate). The high was an **unused `express` dependency** (zero imports anywhere, dead weight from the two-session merge) — removed outright, not just patched. Remaining 4 are `esbuild` via `drizzle-kit`'s dev-only loader; `npm audit fix --force` only offers a 13-minor-version downgrade of drizzle-kit for a dev-server-only issue never invoked by this project's usage — accepted and documented rather than forced or hidden
- [x] Found and fixed: **no password-reset flow existed at all** — wired up via Better Auth's `sendResetPassword` (reuses Phase 5's optional-SMTP no-op-safe helper), proven with a real test including an account-enumeration check (unknown email gets an identical response, no verification row created)
- [x] Found and fixed: Better Auth's built-in rate limiter was implicitly OFF in dev (only implicitly on via `NODE_ENV=production`) — made explicit; proven load-bearing by deliberately disabling it, watching the test fail, then restoring it
- [x] Found and fixed: no rate limiting on manual crawl triggering beyond the monthly quota (which does nothing against a burst) — added a small in-memory per-user limiter, proven on a plan with an *unlimited* monthly quota specifically so only the new burst limiter could be the one blocking the 11th rapid call
- [x] Found and fixed: **CSV formula injection (CWE-1236)** in the report generator — a crawled page title starting with `=`/`+`/`-`/`@`/tab/CR would execute as a formula when opened in Excel/Sheets; fixed with the standard leading-quote mitigation, proven with 8 tests
- [x] HTML report XSS — reviewed and confirmed already-correct escaping, proven load-bearing the same way (removed one `escapeHtml()` call, watched the regression test fail, restored it)
- [x] Endpoint/action audit — full table in `SECURITY_REVIEW.md`; every route/action is either intentionally public or gated via `require-org-access.ts`/session/role checks; no ungated endpoint found
- [x] Docker hardening — both Dockerfiles now run as non-root users, added a root `.dockerignore` (the worker image's repo-root build context was sending `app/.env` and `.git` to the Docker daemon on every build), added CPU/memory resource limits to every `docker-compose.yml` service. **Not verified with an actual `docker compose build`** — no usable Docker daemon in this sandbox (same honest caveat carried since Phase 2/3) — needs a spot-check on a real machine
- [x] `SECURITY_REVIEW.md` — full writeup, before/after audit numbers, endpoint-gating table, explicit known-gaps section
- [x] `TEST_RESULTS.md` — real counts, build/lint status, honest per-category coverage map

**Independently re-verified in this session, on the real code (not just trusting the report):** confirmed `express` actually removed and `npm audit` shows 4/0/0 (moderate/high/critical) via a direct re-run; confirmed the rate-limit config, CSV formula-injection fix (even more thorough than claimed — also covers tab/CR, not just the basic OWASP four), password-reset wiring, and both Dockerfiles' non-root `USER` directives by reading the source directly; confirmed `docker-compose.yml` has resource limits on all 4 services. `npx vitest run` → **191 passed, 2 skipped (193), exit 0**. `npm run build` → exit 0, 13 routes (including new `/forgot-password`, `/reset-password`). `npx eslint .` → 0 errors, 4 pre-existing warnings in files this phase never touched.

**Known gaps, carried forward honestly:** 4 moderate dependency findings accepted (dev-only, unreachable in production usage, forcing the fix would mean a major downgrade); Docker changes unverified by an actual build in any sandbox so far; in-memory rate limiters are single-process by design (matches this project's single-instance target, won't coordinate across multiple app instances — a real multi-instance deployment would need a shared store); production needs a correctly configured reverse proxy for Better Auth's IP-based rate limiting to key on real client IPs, flagged for `DEPLOYMENT.md`.

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
