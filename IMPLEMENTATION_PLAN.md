# AI SEO Platform — Implementation Plan & Master Checklist

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked/needs decision

> **Resolved:** this repository's existing `index.html` (a "Belmont Digital"
> marketing landing page, unrelated to this project) stays untouched. The
> SEO platform is built entirely under `seo-platform/`. All deliverable docs
> (README, ARCHITECTURE, SECURITY_REVIEW, etc.) live inside `seo-platform/`
> rather than the repo root.

---

## Phase 0 — Housekeeping (this step)
- [x] Inspect working directory and git history
- [x] Identify conflict between existing repo content and new project scope
- [x] Write this checklist / implementation plan
- [x] Get confirmation on repo layout decision → `seo-platform/` subdirectory
- [x] Set up session TaskCreate tracking mirroring phases below

## Phase 1 — Research & Architecture
- [ ] Inspect `IamRamgarhia/All-In-One-Free-SEO-Tool` (stack, license, activity, tests)
- [ ] Inspect `janreges/siteone-crawler` (stack, license, activity, tests)
- [ ] Inspect `PhialsBasement/LibreCrawl` (stack, license, activity, tests)
- [ ] Inspect `StJudeWasHere/seonaut` (stack, license, activity, tests)
- [ ] Inspect `crawlseo/crawlseo` (optional reference)
- [ ] Inspect `every-app/open-seo` (optional reference)
- [ ] Record license obligations for anything reused (MIT/Apache/GPL compatibility check)
- [ ] Verify documentation claims against actual source where feasible
- [ ] Write `ARCHITECTURE.md` — chosen foundation + rationale
- [ ] Write `REVERSE_ENGINEERING.md` — per-repo findings (architecture, crawling algo, SEO rules, DB schema, auth, reports, tests, security)
- [ ] Write `FEATURE_COMPARISON.md` — feature matrix across all 6 repos
- [ ] Write `INTEGRATION_ARCHITECTURE.md` — adapter boundaries, common crawl-result schema

## Phase 2 — Working Application Foundation
- [ ] Scaffold chosen foundation (backend + frontend + DB) under `seo-platform/`
- [ ] Docker Compose: app, db, worker, (crawler), (ollama)
- [ ] `.env.example` with placeholders only, no real secrets
- [ ] DB migrations: orgs, users, websites, crawl_jobs, findings, reports
- [ ] Health check endpoints
- [ ] App boots and renders a first page locally — proof of life

## Phase 3 — Advanced Crawling
- [ ] Crawler adapter interface + versioned normalized result schema
- [ ] Integrate primary crawler engine
- [ ] SSRF/private-network/localhost/DNS-rebinding/redirect/decompression-bomb protections
- [ ] robots.txt + crawl-delay + rate limiting respect
- [ ] Core technical SEO checks (titles, meta, headings, canonical, status codes, redirects, robots/sitemap, alt text, structured data, hreflang, thin/duplicate content)
- [ ] Local fixture test sites with known defects
- [ ] Automated crawler accuracy tests against fixtures

## Phase 4 — Reporting & AI
- [ ] Ollama provider integration (optional, app works without it)
- [ ] AI recommendation engine tied to concrete findings (no fabricated metrics)
- [ ] Report generator: PDF/HTML/CSV/JSON
- [ ] Health-score calculation (documented, transparent)
- [ ] Verify report accuracy against known fixture findings

## Phase 5 — Monitoring
- [ ] Background job system (queue, retries, cancellation, persistence across restarts)
- [ ] Scheduling (daily/weekly/monthly)
- [ ] Historical comparison between crawls
- [ ] Notifications (email optional/configurable)

## Phase 6 — SaaS Features
- [ ] Auth (registration, login, password hashing, sessions)
- [ ] Orgs, roles, members, tenant isolation
- [ ] Plans/quotas (Free/Starter/Professional/Agency — configurable, not validated market prices)
- [ ] Stripe adapter in test mode (webhook signature verification, idempotency) or mock if no credentials
- [ ] Billing explicitly stays in test mode — no live payments without approval

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
