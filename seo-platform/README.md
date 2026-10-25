# AI SEO Platform

A self-hosted SEO audit tool: point it at a website, it crawls the site
for real technical/on-page SEO issues, generates AI-assisted
recommendations (via a local Ollama model, with a safe deterministic
fallback when AI isn't available), and produces a client-ready PDF/HTML/
CSV/JSON report. It supports scheduled recurring audits, multi-tenant
organizations with role-based access, and a test-mode Stripe billing
integration — though per the project owner's own direction (see
`REMAINING_WORK.md`), it's currently run as an internal tool for one
operator's freelance SEO audit work, not deployed as a public SaaS.
Built fresh (not forked from any existing tool), reusing the
`siteone-crawler` Rust binary as the crawl engine and Better Auth for
accounts — the full reasoning is in `docs/ARCHITECTURE.md`.

Status: all 8 planned phases complete (research → foundation → crawling
→ reporting/AI → monitoring → SaaS features → security/QA → deployment
prep). See `IMPLEMENTATION_PLAN.md` for the full build history and
`REMAINING_WORK.md` for what's honestly still open — this README
doesn't repeat either, it links to them.

## Tech stack

- **App**: Next.js 16 (App Router) + TypeScript, React 19
- **Database**: PostgreSQL + Drizzle ORM
- **Auth**: Better Auth (email/password, `organization` plugin for multi-tenancy)
- **Job queue**: pg-boss (Postgres-native — no Redis/extra infra)
- **Crawler**: `janreges/siteone-crawler` (vendored Rust binary, MIT), invoked as a subprocess
- **AI**: Ollama (local, optional) via an OpenAI-compatible endpoint
- **Billing**: Stripe, test-mode only by a hard-coded guard (`sk_test_...` keys only)
- **Reports**: `pdfkit` for PDF, hand-rolled HTML/CSV/JSON — no headless browser needed
- **Deployment**: Docker Compose (`app`, `worker`, `postgres`, optional `ollama`)

## Prerequisites

- Node.js 20+ and npm
- Docker + Docker Compose plugin (for Postgres locally, and for the full
  containerized stack in production — see `docs/DEPLOYMENT.md`)
- Ollama (optional) — only needed if you want AI-generated recommendations
  instead of the deterministic template fallback

## Setup

This project targets two environments per its original spec: **Windows**
for day-to-day development, **Linux** (Docker Compose) for production.
Both follow the same core steps; the difference is how you run the
long-lived processes.

### Common first steps (either OS)

```bash
git clone <this repo>
cd seo-platform

# Bring up just Postgres in Docker (works identically on Windows/Linux
# with Docker Desktop / Docker Engine)
docker compose up -d postgres

cd app
npm install
cp .env.example .env
# Edit .env: at minimum confirm DATABASE_URL matches the Postgres
# container above (the example value already does, for local dev).

npx drizzle-kit migrate
```

### Windows dev

```powershell
# From seo-platform/app:
npm run build
npm run start      # the Next.js app, on http://localhost:3000
npm run worker      # in a second terminal — the pg-boss job worker

# Optional: local fixture test sites with known SEO defects, used to
# sanity-check the crawler against real content (seo-platform/fixtures/):
cd ..\fixtures
npm install
npm start           # http://127.0.0.1:4100
```

`scripts/dev-start.ps1` / `dev-stop.ps1` automate the above (launching
the app, worker, and fixture server each in their own window, and — this
matters — actually killing the real underlying `node`/`tsx` processes on
stop, not just the wrapping PowerShell window; see that script's own
comments for why that distinction was a real bug once).

### Linux production (Docker Compose)

See `docs/DEPLOYMENT.md` for the full walkthrough — health checks,
backup/restore, logging, upgrades, and reverse-proxy/HTTPS setup. Short
version:

```bash
docker compose build
docker compose up -d
curl http://127.0.0.1:3000/api/health   # {"status":"ok","db":"connected"}
```

### Running the tests

```bash
cd app
npx vitest run
```

As of Phase 7/8: **191 passed, 2 skipped** (the 2 skipped tests need a
real local Ollama model and are skipped automatically, not disabled by
choice, when none is reachable — see `docs/TEST_RESULTS.md`).

## What's actually done vs. partial

This section is a quick scan, not the source of truth — cross-check
`IMPLEMENTATION_PLAN.md` (full build history with real command output
per phase) and `REMAINING_WORK.md` (the current, prioritized punch list)
for the honest detail behind every line here.

**Done and tested:**
- Real crawling (static HTTP; JS-rendering/`--browser` mode exists in the
  binary but has never actually been exercised — see "partial" below),
  SSRF/private-network protection, robots.txt respect, core technical SEO
  checks (titles, meta, headings, canonicals, hreflang, broken links,
  JSON-LD, sitemap/orphan-page detection)
- AI-crawler-visibility check (GPTBot/ClaudeBot/PerplexityBot robots.txt
  blocking, `llms.txt` presence)
- AI-generated recommendations grounded in real findings (no fabricated
  metrics, enforced by both prompt and a code-level guard), with a
  deterministic fallback when no AI is configured
- PDF/HTML/CSV/JSON report generation, with category score breakdowns,
  an SVG score gauge, and a historical-comparison chart across crawls
- Scheduled recurring crawls (daily/weekly/monthly), job retry/crash
  recovery, cancellation, and in-app + optional-email notifications
- Multi-tenant organizations, role-based (owner/admin/member)
  authorization, tenant-isolation enforcement, audit logging
- Plans/quotas and a Stripe billing integration — **test mode only**,
  by design and by a hard guard in the code, not a placeholder left
  unfinished
- Password reset, auth rate limiting, CSV-formula-injection protection,
  non-root Docker images, per-service resource limits

**Partial / known gaps** (see `REMAINING_WORK.md` for the full,
prioritized list):
- JS-rendering crawl mode (`--browser`) has never been run for real — no
  Chromium is available in either the build sandbox or the Docker images
  yet
- No live Stripe account has ever been exercised (webhook signature
  verification is proven offline only)
- Rate limiters are single-process/in-memory — fine for this project's
  single-instance target, would need a shared store to scale to multiple
  app replicas
- No org-switcher UI (a user's "active org" is just the first one returned)
- The "premium UI/UX" design-system pass from the original brief was
  deprioritized by the project owner in favor of report-output quality —
  the app itself is a plain, functional, unstyled-beyond-defaults dark UI

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — why this stack, what was reused from prior art, license compliance
- [`docs/REVERSE_ENGINEERING.md`](docs/REVERSE_ENGINEERING.md) — per-repo findings from the 6 candidate open-source tools evaluated in Phase 1
- [`docs/FEATURE_COMPARISON.md`](docs/FEATURE_COMPARISON.md) — feature matrix across those 6 repos
- [`docs/INTEGRATION_ARCHITECTURE.md`](docs/INTEGRATION_ARCHITECTURE.md) — crawler adapter boundary, normalized result schema
- [`docs/AI_AND_SCORING.md`](docs/AI_AND_SCORING.md) — health-score formula, AI recommendation grounding/guardrails
- [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md) — endpoint/action gating audit, dependency scan history, Docker hardening
- [`docs/TEST_RESULTS.md`](docs/TEST_RESULTS.md) — real test/build/lint output, coverage map
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — production setup, backup/restore, logging, HTTPS/reverse-proxy
- [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) *(repo root)* — the full phase-by-phase build log, including known gaps as they were found
- [`REMAINING_WORK.md`](REMAINING_WORK.md) — the current, honest, prioritized "what's left" list
- [`CHANGELOG.md`](CHANGELOG.md) — real history by phase/milestone, from actual git commits
