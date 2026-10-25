# Changelog

Real history, derived directly from this repository's git log
(`git log --oneline --date=short`) plus `IMPLEMENTATION_PLAN.md`'s own
phase summaries — not invented dates or marketing copy. Dates are the
actual commit dates in this repo. Where a later commit reconciled or
corrected an earlier one, both are listed in commit order, not merged
into one tidy line.

## 2026-04-07 — Initial commit

`9b54593` — Repository created (pre-dates this project; contained an
unrelated "Belmont Digital" marketing page, left untouched under the
repo root — see `IMPLEMENTATION_PLAN.md`'s opening note on this).

## 2026-10-21 — Phase 0/1: Planning and research

- `9f8d2ff` — Master implementation plan and checklist added.
- `6c6fe9b` — Phase 1: researched 6 candidate open-source SEO/crawler
  repos (license, stack, test coverage, CI, verified-vs-claimed
  features); decided to build the app foundation fresh rather than fork
  any of them, reusing three specific components via thin adapters. See
  `docs/REVERSE_ENGINEERING.md`, `docs/FEATURE_COMPARISON.md`,
  `docs/ARCHITECTURE.md`.
- `8c77879` — Corrected the architecture doc's job-queue choice to
  pg-boss (Postgres-native), not BullMQ (would have needed Redis).

## 2026-10-21 — Phase 2: Working application foundation

- `db16749` — Next.js 16 (App Router) + TypeScript, Postgres + Drizzle
  ORM, Better Auth (email/password + `organization` plugin). Docker
  Compose scaffolded (`app`, `postgres`, `worker`, optional `ollama`).
  Health check endpoint, initial migration (11 tables), sign-up →
  session → org-create → dashboard flow all verified working.

## 2026-10-21 — Phase 3: Advanced crawling

- `52b4e64` — Crawler adapter interface and normalized result schema;
  `siteone-crawler` (Rust binary, MIT) vendored and integrated as a
  subprocess. SSRF/private-network/DNS-rebinding/redirect/decompression-
  bomb protections (`crawl-safety.ts`) — including the discovery that
  the crawler binary itself doesn't protect against SSRF on redirects,
  fixed by scoping every invocation to the pre-validated origin. Core
  technical SEO checks, local fixture test sites with known defects, and
  a fixture-based accuracy test suite (63/63 passing at the time).

## 2026-10-21 — Phase 4: Reporting and AI

- `aed4d93` — Real Ollama integration for AI-generated recommendations
  (not stubbed), grounded in concrete findings with no fabricated
  metrics (enforced by both a prompt instruction and a code-level
  regex guard — which caught a real violation during testing). PDF
  (`pdfkit`)/HTML/CSV/JSON report generation from one shared payload.
  Health-score formula documented in `docs/AI_AND_SCORING.md`.

## 2026-10-21 — Phase 5: Monitoring

- `7007f81` — pg-boss-based background job system with retry/expiry
  policy, job cancellation (real subprocess kill via `AbortSignal`),
  crash-recovery proven empirically (a worker process SIGKILLed
  mid-crawl, confirmed recovered by a fresh worker), daily/weekly/
  monthly scheduling, configurable concurrency, historical crawl
  comparison (`findings-diff.ts`), and in-app + optional-SMTP
  notifications.

## 2026-10-21 — Windows real-machine testing and report polish

- `a964c9a` — Fixed `npm install` failing on a fresh clone (ERESOLVE;
  missing `.npmrc`).
- `16d4f3c` — Fixed the crawler never running on Windows (the vendored
  binary was Linux-only); vendored a Windows binary and picked by
  `process.platform`.
- `cf1f54d` — Closed a real tenant-isolation gap found during
  Windows testing (any authenticated user could view/act on any other
  org's websites/reports by guessing a UUID); moved SSRF validation to
  add-website time instead of surfacing as a confusing post-crawl
  "finding".
- `5e738e7` — Began Phase 6 billing work in parallel on this same
  branch (see the Phase 6 entry below for how this was reconciled).
- `91ad410` — Competitive research on SEO report design (CrawlRaven,
  Sitebulb/Ahrefs-style dashboards), written up for the Part 3/5
  "premium UI/UX" brief.
- `30b39ca` — Report-polish pass: category-level score breakdowns
  (Technical/On-Page/Content/AI Visibility), an AI-crawler-visibility
  check (GPTBot/ClaudeBot/PerplexityBot robots.txt blocking, `llms.txt`
  presence), inline-SVG score gauge and historical-comparison chart in
  the HTML report.

## 2026-10-25 — Phase 6: SaaS features (two parallel implementations, reconciled)

A second Claude Code session, started independently by the project
owner on their own machine, was doing its own Phase 6 work on this same
branch at the same time, unaware of this session's parallel work — both
built real, tested tenant-isolation and billing implementations before
either knew about the other.

- `db9bd0e` — This session's Phase 6 work: tenant-isolation enforcement
  with role-based (`minRole`) gating, audit logging (`audit_log` table,
  9 call sites).
- `624cb8b` — **Merge commit reconciling both sessions' work.** The
  other session's branch was adopted as the base (more complete on
  billing — a `BillingProvider` interface with a `MockBillingProvider`
  default, Windows crawler support, report-generation polish, add-time
  SSRF validation); this session's role-based authorization and audit
  logging were ported onto it. Nothing was discarded without being
  superseded by an equivalent or better implementation on the other
  side — see `IMPLEMENTATION_PLAN.md`'s Phase 6 section for the full
  reconciliation detail.
- `6d0affd` — Documented the reconciliation honestly in
  `IMPLEMENTATION_PLAN.md` rather than presenting it as a single linear
  effort.

Net result: org roles enforced, plans/quotas (Free/Starter/Professional/
Agency) with real enforcement, Stripe adapter in **test mode only**
(hard-guarded — `sk_live_`/`rk_live_` keys rejected outright), webhook
signature verification with idempotency, audit logging. 173 passed, 2
skipped on the final reconciled code.

## 2026-10-25 — Phase 7: Security and QA

- `3a9b64e` — Full security review and endpoint-gating audit
  (`docs/SECURITY_REVIEW.md`); dependency vulnerability scan (removed an
  unused `express` dependency, eliminating the one high-severity
  finding); **found and fixed**: no password-reset flow existed at all
  (wired up via Better Auth, with an account-enumeration check);
  Better Auth's rate limiter was implicitly off in dev; no burst rate
  limiting on manual crawl triggering; CSV formula injection (CWE-1236)
  in the report generator. Docker images hardened to run as non-root,
  with per-service CPU/memory resource limits added to
  `docker-compose.yml`. 191 passed, 2 skipped.

## 2026-10-25 — Phase 8: Deployment preparation (this phase)

Not yet a git commit as of this writing — the coordinating session
reviews and commits this phase's work. Summary of what it adds:

- **Docker verified for real for the first time** — a working Docker
  daemon was obtained in this sandbox instance, and a real
  `docker compose build` + `docker compose up -d` brought up all three
  services (`postgres`, `app`, `worker`) healthy, with `/api/health` and
  the worker's `/healthz` both confirmed live through the containers.
  Closes a gap every prior phase (2, 3, 7) had carried as "unverified."
- **Real gap found and fixed**: `docker-compose.yml`'s `app` service had
  no volume for `/app/storage/reports` — generated reports would be
  silently lost on every container rebuild/recreate. Added the
  `app_reports` named volume, proven with an actual recreate-and-check.
- `docs/DEPLOYMENT.md`, `README.md`, `CHANGELOG.md` added;
  `REMAINING_WORK.md` updated to reflect everything Phase 7 already
  closed; `scripts/backup.sh` added (real, runnable `pg_dump`-based
  backup of Postgres plus the reports directory, with a matching
  restore procedure documented).
