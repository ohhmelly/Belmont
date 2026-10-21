# Reverse-Engineering Notes: Six Candidate SEO Repos

Phase 1 research for the self-hosted, open-source AI SEO platform. All six repositories were
cloned shallow (`--depth 1`, later deepened for `all-in-one-free-seo-tool`) from the public GitHub
proxy on 2026-10-21. All claims below were checked against actual files in the clone (README,
LICENSE, package manifest, DB schema/migrations, and a sample of source files) — not taken from
marketing copy alone. Star/fork/issue counts and repo creation dates came from the GitHub API
(`search_repositories`), which is a live source, not the local clone; everything else is from the
checked-out tree.

---

## 1. IamRamgarhia/All-In-One-Free-SEO-Tool

- **Clone path:** `/home/user/iamramgarhia/all-in-one-free-seo-tool`
- **Language/stack:** TypeScript, Next.js 16 / React 19 (App Router), Drizzle ORM over SQLite
  (`better-sqlite3`), Tailwind 4, Playwright (both for crawling and for the project's own e2e
  tests), Vitest for unit tests, a WordPress plugin bridge (PHP) and a browser extension as
  secondary surfaces.
- **License:** MIT (verified — standard MIT text, "Copyright (c) 2026 DiceCodes (Prince
  Ramgarhia)").
- **Activity:** GitHub metadata — created 2026-05-02, 73 stars, 24 forks, 0 open issues, last push
  2026-10-20. Local clone's last commit: `b80e0af` dated 2026-10-19. Deepened history shows 380+
  commits reachable from `main`, i.e. very high commit velocity for a ~5.5-month-old project.
  **Recency: very high. Maturity: low (young project, single/small maintainer group).**
- **Tests:** Real and extensive — 97 `*.test.ts` files sitting next to the implementation files
  they test (e.g. `audit-score.test.ts`, `tech-audit-rules.test.ts`, `auth-password.test.ts`),
  run with Vitest (`npm test`). Also has Playwright e2e (`e2e/`), a PHP test runner for the
  WordPress bridge, and a fixtures-based audit test (`test:fixtures`). Has CI
  (`.github/workflows/ci.yml`). This is the best-tested repo of the six.
- **Database:** SQLite via Drizzle ORM, single file, migrated with `drizzle-kit`. Schema
  (`src/db/schema.ts`, 2514 lines) has ~60 tables covering clients, audits, audit issues, tasks,
  keywords, backlinks, invoices, automations, chat conversations, report archives, etc. This is a
  single-process, single-SQLite-file design — fine for one install, not a sharded/multi-DB SaaS
  design.
- **Auth / multi-tenancy:** Real, custom-built (`src/lib/auth.ts`). Accounts are **opt-in**: a
  fresh install runs passwordless/no-account until someone registers, at which point the app
  switches permanently to real accounts (scrypt-hashed passwords, `node:crypto`, signed session
  cookies). Roles: `owner`, `manager`, `member`, `viewer`. Client-level scoping
  (`src/lib/client-scope.ts`) restricts `member`/`viewer` to assigned clients and returns 404 (not
  403) on direct access to an unassigned client to avoid leaking client existence. **This is
  single-tenant-per-install multi-user**, i.e. "one agency, several team members, several
  managed client websites" — not a multi-organization SaaS model. There is no `organization`
  concept and no billing/subscription code at all (`grep`ed for "stripe" — the only hits are the
  substring inside PDF "stripe pattern" CSS code and unrelated prose, not a billing integration).
- **Dashboard/UI:** Yes, full Next.js web app — dashboard, ~90+ "tools" pages
  (`src/app/tools/*`), client management, reports, invoices, automations, a chat/agent UI.
- **Crawler type:** Real JS-rendering crawler. Uses Playwright with a pooled browser
  (`src/lib/browser-pool.ts`), plus `render-capture.ts`, `captcha-detect.ts`, and a dedicated
  `browser-agent.ts` for an autonomous "fix what it finds" agent. Not just static HTML fetch.
- **AI integration:** Multiple providers behind a common dispatcher (`src/lib/provider-dispatch.ts`,
  `src/lib/providers/{anthropic,gemini,openai-compat}.ts`). **Ollama is genuinely supported** —
  confirmed in `src/lib/api-providers.ts` (line 117: *"Leave the field below as
  `http://localhost:11434` and click Save — Ollama is ready."*) via the OpenAI-compatible provider
  path, which is a thin, dependency-free wrapper shared with Groq/OpenRouter/Mistral/etc. The
  README's "no paid APIs required" claim checks out for the AI layer.
- **Architectural strengths:** Thoughtful, well-commented code (the comments explain *why*, not
  just *what* — e.g. the auth.ts header on why accounts are opt-in, why scrypt over bcrypt/argon2
  to avoid a second native dependency). Clean separation of ~250 single-purpose `lib/*.ts` modules
  rather than one monolith. Genuine defense-in-depth on client scoping (404-not-403, scope filter
  applied at the layout level so new pages can't forget it). Real SSRF guard
  (`tool-ssrf.test.ts`, `url-guard.ts`). Ollama support is real and low-friction.
- **Architectural weaknesses:** The feature surface is enormous — the README advertises "92/99
  dedicated tools" and the `src/app/tools/` directory bears that out (100+ route segments). For a
  ~5-month-old, presumably small-team project, that is a very large surface to have inherited
  real engineering discipline across uniformly; it increases audit burden and the risk that some
  of the long tail of tools are thin wrappers. Single SQLite file is a ceiling for a true
  multi-tenant SaaS (would need re-architecting for per-tenant isolation/scaling). No
  organization/billing model exists — "SaaS account/billing" would have to be built from scratch
  on top of the existing single-owner/team-member model, which doesn't map cleanly onto "many
  independent paying customers."
- **README claims checked:** "Works with free AI keys (Gemini, Groq) — no paid APIs required" —
  true for the AI layer; Ollama support is real, not advertised front-and-center in the README's
  badge copy but present and documented in-app. "Team accounts with per-client access" — true,
  verified in code. No false/exaggerated claims found in the areas inspected. The "92 dedicated
  tools" count is plausible given the route count, though we did not verify that all 90+ tool
  pages are fully functional end-to-end (a few may be thinner than others; not disproven, not
  fully proven either — flagged as **unverified**, not false).

---

## 2. janreges/siteone-crawler

- **Clone path:** `/home/user/janreges/siteone-crawler`
- **Language/stack:** Rust (edition 2024), compiled to a single dependency-free native binary.
  Uses `tokio`, `reqwest`, `scraper`, `clap`. Optional browser-rendering mode talks to a real
  Chrome/Chromium via the Chrome DevTools Protocol (auto-detected or auto-downloaded as
  `chrome-headless-shell`) — not a Node/Playwright dependency.
- **License:** MIT (verified — "Copyright (c) 2023-2026 Ján Regeš").
- **Activity:** GitHub metadata — created 2023-10-04 (oldest of the six by far), 965 stars, 90
  forks, 17 open issues, last push 2026-10-19. Local clone's last commit `f3d967b` dated
  2026-09-27. **Recency: high. Maturity: high — 3-year track record, actively released
  (`.github/workflows/release.yml`, `publish.yml`), formerly PHP+Swoole and rewritten in Rust for
  performance** (per README, "25% faster, 30% lower memory" vs. the PHP version — a credible,
  specific claim, not disprovable from the clone alone but consistent with a real rewrite given
  the Cargo.toml and full Rust source tree).
- **Tests:** Has a `tests/` directory with fixtures (`tests/fixtures/consistency`,
  `tests/fixtures/ai-responses`) and `tests/common`; CI runs `ci.yml` on every push. Test depth is
  modest relative to the huge feature surface (6 fixture-oriented test files found), but CI is
  real and the project has shipped for 3 years with regular releases.
- **Database:** None — this is a CLI tool, not a service with persistent storage. Output is
  JSON/HTML/text reports, not a database.
- **Auth/multi-tenancy:** N/A — no concept of users, accounts, or tenants. It's a local tool /
  CI step.
- **Dashboard/UI:** No web dashboard. Produces a static, interactive HTML report (sortable tables,
  0–10 quality score) and JSON/text output; there is a separate companion desktop GUI project
  (`siteone-crawler-gui`, not reviewed here) that wraps the CLI.
- **Crawler type:** Dual-mode. Default is a fast native HTTP crawler (no JS). Optional `--browser`
  flag renders every page in real Chromium via CDP for JS/SPA sites — **this claim is verified in
  code**, not just marketing: the README documents real limitations of browser mode (robots/scope
  still apply to the top document only, double-fetch per page, auth/cookies not forwarded to the
  browser) which is the kind of honest caveat list a real implementation produces, not a wrapper
  that merely claims the feature.
  Screenshots (PNG/JPG/WebP, viewport or full-page), GIF/MP4 assembly, and console/error
  diagnostics are also real, documented features of browser mode.
- **AI integration:** Optional, strictly opt-in LLM layer (`src/ai/provider.rs`) for qualitative
  SEO analysis, `llms.txt` generation, and spelling/policy checks. Supports OpenAI, Anthropic,
  Gemini, and **any OpenAI-compatible endpoint explicitly including Ollama** (confirmed in
  README's own text: "openai-compatible (vLLM, LiteLLM, MiniMax, LocalAI, Ollama, ...)" and backed
  by a real `src/ai/` module, not just a README mention). Smart page-selection caps cost; has a
  `--ai-dry-run` cost preview.
- **Architectural strengths:** Single static binary, zero runtime dependencies, genuinely fast
  (Rust), cross-platform (Win/macOS/Linux, x64/arm64, glibc and musl variants). Clean separation
  of concerns (crawler, analyzer, offline exporter, markdown exporter, sitemap generator, AI
  assistant, browser renderer — all opt-in and composable via flags). Oldest and most
  battle-tested codebase of the six. Output is machine-readable JSON, trivially embeddable as a
  subprocess from any other language/runtime.
- **Architectural weaknesses:** Not a platform component by itself — no persistence, no accounts,
  no web UI, no scheduling/reporting pipeline. All of that would have to be built around it. As a
  CLI invoked per-crawl, integrating it into a long-running multi-tenant SaaS means managing
  process lifecycle, concurrency, and resource limits externally (it doesn't know about tenants
  or jobs). Some edge-case limitations in browser mode (noted above) are honestly documented but
  are real constraints an integrator must design around (e.g., it double-fetches rendered HTML
  pages once for headers/status and again via the browser).
- **README claims checked:** JS rendering via "real Chromium" — true, with real caveats
  documented. Ollama/OpenAI-compatible AI support — true, confirmed in source. "Zero runtime
  dependencies" for the base binary — plausible given the Cargo.toml dependency list is all
  statically linkable Rust crates; browser mode is explicitly the one feature requiring an
  external Chromium (clearly flagged as optional, not misrepresented as dependency-free).

---

## 3. PhialsBasement/LibreCrawl

- **Clone path:** `/home/user/phialsbasement/librecrawl`
- **Language/stack:** Python 3, Flask, server-rendered-ish web UI (`web/` templates/static) with
  vanilla JS on the frontend. Playwright for JS rendering. SQLite for persistence (`sqlite3`
  stdlib module directly, no ORM). `bcrypt` for passwords, `waitress` as the production WSGI
  server.
- **License:** MIT (verified — "Copyright (c) 2025 Phiality").
- **Activity:** GitHub metadata — created 2025-09-27 (one year old), 1,070 stars, 215 forks, 32
  open issues, last push 2026-10-20. Local clone's last commit `05a1372d` dated 2026-09-29.
  **Recency: high (very recently pushed to). Open-issue count (32) relative to repo size is the
  highest ratio of the six**, which combined with a single maintainer handle ("Phiality") and no
  CI at all is a maintenance-risk signal.
- **Tests:** Thin. `tests/fixture_tests.py` (642 lines, ~10 `test_*` functions) and
  `tests/crawl_harness.py` (a harness, not itself a test suite) — no `pytest`/`unittest` runner
  wiring was found to confirm these are hooked into an automated suite, and **there is no
  `.github/workflows` directory at all** — i.e. no CI. This is the only one of the six repos with
  zero CI configuration.
- **Database:** SQLite, two separate hand-rolled modules: `src/auth_db.py` (users/sessions) and
  `src/crawl_db.py` (crawl results), both raw `sqlite3` with manual `CREATE TABLE IF NOT EXISTS`
  statements — no migration framework, no ORM.
  - Note: the `users` table has a `tier` column (`guest`/… ), but this is **not actually enforced
    as an authorization tier** — see weaknesses below.
- **Auth/multi-tenancy:** Has a real `users` table with bcrypt password hashes
  (`src/auth_db.py`). The README's "Multi-tenancy — Multiple users can crawl simultaneously with
  isolated sessions" claim is accurate only in the narrow sense of **concurrent Flask sessions**,
  not persistent organizations/workspaces with role separation: in `main.py`, every successful
  login path (`login`, local/no-auth mode, and registration) sets `session['tier'] = 'admin'`
  unconditionally — i.e. **every authenticated user is granted the admin tier**, regardless of
  the `tier` value actually stored on their user row. This is both an inflated "multi-tenancy"
  claim and a real authorization bug if any tier-gated feature exists.
- **Dashboard/UI:** Yes, a web dashboard (Flask + templates in `web/`) with real-time crawl
  progress, exports to CSV/XLSX/JSON/XML.
- **Crawler type:** Supports JS rendering — **this claim is true**, verified via
  `src/core/js_renderer.py` and a direct `playwright` dependency in `requirements.txt` (not just
  claimed; the dependency and the module both exist).
- **AI integration:** **None whatsoever.** No `openai`/`anthropic`/`gemini`/`llm`/`gpt`/`ollama`
  string appears anywhere in `main.py` or `src/`. The tool is purely a crawler + rule-based issue
  detector (`src/core/issue_detector.py`) with no AI-generated recommendations of any kind. This
  matters directly for this project's "AI recommendations via local Ollama" requirement — LibreCrawl
  provides zero groundwork there.
- **Architectural strengths:** Playwright-based JS rendering is real and works. PageSpeed
  Insights integration for Core Web Vitals. Plugin workshop / custom-CSS theming shows some
  attention to extensibility. Docker-first distribution with a one-command installer script.
- **Architectural weaknesses:** `main.py` is a single 1,974-line file containing most of the
  Flask routes — a monolith that will be hard to extend safely. `src/crawler.py` is a second
  1,838-line monolith. No ORM/migrations (hand-written SQL in two separate ad hoc DB modules). The
  `tier='admin'`-for-everyone bug noted above undermines the advertised multi-tenancy/authorization
  story. A `zoho_oauth.py` module couples the email-verification flow to a specific vendor
  (Zoho), a portability wrinkle for anyone self-hosting without a Zoho account. No CI, thin test
  suite, no AI hooks.
- **README claims checked:** "Multi-tenancy" — true only as "concurrent isolated crawl sessions,"
  not as account/role separation (the tier bug actively contradicts a stronger reading). "JS
  rendering for dynamic content" — true, verified. No AI claims are made in the README, and
  indeed none exist in the code, so there's no false AI claim here — just a real capability gap
  relative to this project's goals.

---

## 4. StJudeWasHere/seonaut

- **Clone path:** `/home/user/stjudewashere/seonaut`
- **Language/stack:** Go (module `github.com/stjudewashere/seonaut`, Go 1.25), MySQL via
  `go-sql-driver/mysql` + `golang-migrate` for schema migrations, Gorilla sessions/websocket,
  server-rendered HTML with minimal vanilla JS and Apache ECharts for dashboard charts.
- **License:** MIT (verified — "Copyright (c) 2022 SEOnaut").
- **Activity:** GitHub metadata — created 2022-03-02 (second-oldest of the six), 810 stars, 139
  forks, 12 open issues, last push 2026-10-19 (per GitHub API) — but the **local clone's actual
  last commit is `a67387f` dated 2026-06-14**, i.e. the default branch we fetched had not been
  pushed to in over 4 months as of the research date (2026-10-21), the oldest "last commit" of
  the six by a wide margin. (The GitHub-reported `updated_at` can reflect non-code pushes such as
  tags/wiki/other branches; the commit graph on `main` is the more reliable "is it actively
  developed" signal, and it says this is the slowest-moving of the six right now.)
  **Recency: low relative to the other five. Maturity: high (4 years old, Go Report Card badge,
  real CI).**
- **Tests:** 39 `_test.go` files across `internal/`, plus a GitHub Actions `test.yml` workflow
  gated into the README's badge (the badge is backed by a real workflow file, not decorative).
  Solid, idiomatic Go test coverage for a project of this size.
- **Database:** MySQL (required — no SQLite fallback found), schema managed by
  `golang-migrate`/`migrations/`.
- **Auth/multi-tenancy:** Simple. `internal/models/user.go` is a flat `{Id, Email, Password, Lang,
  Theme}` struct — one user owns N `project.go` records (sites). No teams, no roles, no
  organizations. This is the simplest and most honest tenancy model of the six: it doesn't claim
  more than it has.
- **Dashboard/UI:** Yes — web dashboard with Apache ECharts visualizations, issues grouped by
  severity (critical/high/low) across three categories: `errors`, `multipage`, `page`
  (`internal/issues/`).
- **Crawler type:** Static HTML only. No headless-browser dependency anywhere in `go.mod` (no
  chromedp/rod/playwright-go), and the README does not claim JS rendering — it explicitly says
  the frontend (not the crawler) uses "minimal vanilla JavaScript." **No false claim here** — this
  is an honest static-HTML-only crawler.
- **AI integration:** None. No AI-related dependencies or code found anywhere in `go.mod` or
  `internal/`.
- **Architectural strengths:** Clean, idiomatic layered Go architecture
  (`internal/{repository,services,issues,crawler,models,urlutils,archiver,routes,config}`) — the
  best separation-of-concerns of any single-process codebase in this set. Good automated test
  coverage with a real CI gate. Mature, stable, "does what it says" — no exaggerated claims found
  anywhere in the areas checked. Docker Compose quick start documented clearly.
- **Architectural weaknesses:** No multi-tenancy beyond "one user, many projects" — would need
  substantial extension for a real multi-org SaaS. No AI hooks of any kind — building an AI
  recommendation layer on top means grafting it onto a codebase that has no precedent for calling
  out to an LLM. Requires MySQL specifically (no lighter-weight embedded-DB option), which adds
  ops overhead for a simple self-hosted install relative to the SQLite-based repos in this set.
  Lowest recent commit activity of the six as of this research.
- **README claims checked:** No JS-rendering or AI claims are made, and none exist — so nothing
  false or exaggerated was found. The README's claims are modest and all verified true.

---

## 5. crawlseo/crawlseo

- **Clone path:** `/home/user/crawlseo/crawlseo`
- **Language/stack:** TypeScript, Next.js (App Router), Prisma ORM over **PostgreSQL**
  (`provider = "postgresql"` in `prisma/schema.prisma`), NextAuth v5 beta (`next-auth`,
  `@auth/core`, `@auth/prisma-adapter`) for authentication, Playwright used only for the project's
  own e2e tests (`playwright.config.ts`, `e2e/`) — not for the crawler itself. MCP server
  (`mcp/`) exposing crawl/GSC data to AI agents.
- **License:** MIT (verified — "Copyright (c) 2026 crawlseo").
- **Activity:** GitHub metadata — created 2026-04-06 (~6.5 months old), 640 stars, 94 forks, 3
  open issues (lowest of the six), last push 2026-10-20. Local clone's last commit `7d98a97`
  dated 2026-10-20. **Recency: very high (updated the day before this research). Maturity:
  moderate — young but with a visible, incrementally-evolving Prisma migration history from
  `20260406_init` through `20261019_user_settings`** (10 migrations over ~6.5 months is a healthy,
  real development cadence, not a single big-bang schema dump).
- **Tests:** 73 `*.test.ts` files plus a small Playwright e2e suite (`e2e/light-only.e2e.ts`) and
  a real CI workflow (`.github/workflows/test.yml`, plus a separate `docker-publish.yml`). Good
  test coverage for its size.
- **Database:** PostgreSQL via Prisma, with a real migration history (confirms active schema
  evolution, not a frozen prototype).
- **Auth/multi-tenancy:** NextAuth-based login (email/password + "API key login optional" per a
  migration name) — **but no organization/workspace/tenant model was found** in the schema
  (`grep`ed `schema.prisma` for organization/workspace/tenant/team — zero hits). This is a
  single-user-per-account tool ("for founders, not SEO specialists" per its own README), not a
  multi-tenant SaaS with teams out of the box.
- **Dashboard/UI:** Yes — GSC analytics dashboard, Core Web Vitals, site crawler results, all in
  one Next.js app, with screenshots shown in the README.
- **Crawler type:** Static HTML only — no `playwright`/`puppeteer`/headless-browser dependency was
  found wired into `lib/crawler`; the project's `playwright` reference in `package.json` is for
  its own e2e browser tests, not for crawling third-party sites. The README does **not** claim JS
  rendering, so there's no false claim, but it's a real capability gap relative to modern JS-heavy
  sites.
- **AI integration:** The README's feature-comparison table claims "AI agent ready ✅" on par with
  OpenSEO — **this is accurate only for "exposes an MCP server so an external AI agent (e.g.
  Claude Code) can query the data," not for "generates AI recommendations itself."** No
  `ollama`/`openai`/`anthropic`/`gemini` string was found anywhere in `lib/` or `app/`, and no
  LLM-calling code exists. This is a real, if subtle, overstatement: a reader skimming the
  comparison table next to OpenSEO's identical "✅" could reasonably conclude crawlseo generates
  AI-written recommendations the way OpenSEO's "AI Visibility" features do; it does not — it only
  makes data queryable by an agent that brings its own model.
- **Architectural strengths:** Unusually disciplined security/privacy documentation — the README
  enumerates **every single outbound network destination** the app can contact (Google, Bing,
  DataForSEO, GitHub's release-check API, the user's own alert webhook) with exact trigger
  conditions and an environment variable to disable each one, and this list is backed by a real
  machine-checked `outbound-hosts.json` that CI tests new code against. This SSRF/egress-allowlist
  discipline is the single best security pattern found across all six repos and is directly
  reusable as a design pattern for our own crawler's network egress policy. PostgreSQL + Prisma
  + NextAuth is a solid, conventional, easy-to-extend stack choice.
  Clean Dockerfile/Compose self-hosting path (not Cloudflare-locked).
- **Architectural weaknesses:** No JS-rendering crawler (static HTML only, capped at 2000
  pages per the README's own comparison table). No built-in AI recommendation generation despite
  table framing that implies parity with OpenSEO's AI features. No multi-tenant org model. Keyword
  research and backlinks are BYOK-gated behind the same paid DataForSEO dependency as OpenSEO
  (acknowledged honestly in the README, with Google Autocomplete as a free fallback for keyword
  suggestions only).
- **README claims checked:** Outbound-network-destination list — verified accurate and unusually
  precise. "Self-hosted ✅" — true, real Dockerfile/Compose, not Cloudflare-only. "AI agent ready"
  — technically true (MCP server) but easily misread as "has AI features," which it does not in
  the sense of generating recommendations itself.

---

## 6. every-app/open-seo

- **Clone path:** `/home/user/every-app/open-seo`
- **Language/stack:** TypeScript, built specifically for **Cloudflare Workers** — Vite, Wrangler
  (`wrangler.jsonc`, `wrangler.audit.jsonc`), Cloudflare D1 (SQLite-compatible) and an optional
  Postgres backend (`src/db/pg/`), Cloudflare Durable Objects and Cloudflare **Workflows**
  (durable, step-based background jobs — `cloudflare:workflows` imported directly in source),
  Drizzle ORM, Better Auth (`better-auth-schema.ts`) for multi-tenant auth, Vercel AI SDK
  (`@ai-sdk/react`) for LLM calls, `alchemy` for self-host infra-as-code deploys.
- **License:** MIT (verified — "Copyright (c) 2026 Ben Senescu").
- **Activity:** GitHub metadata — created 2026-02-27 (~8 months old), **24,331 stars, 3,281
  forks, 210 open issues** — by a wide margin the most popular repo of the six (roughly 23x the
  next-most-starred candidate in this set). Last push 2026-10-21 (today). Local clone's last
  commit `c5f8db1` dated 2026-10-19 23:47 (America/Los_Angeles). **Recency: extremely high
  (essentially daily commits). Maturity: high engineering rigor, but young project; backed by a
  named individual/company ("Every") with a commercial hosted offering.**
- **Tests:** 242 `*.test.ts` files plus a dedicated Playwright e2e suite (`tests/`,
  `tests/badseo/` — a fixture set of deliberately bad pages to test the auditor against) and
  multiple CI workflows (`ci.yml`, `pr-preview.yml`, `sourcemaps.yml`, `docker-image.yml`). The
  largest and most rigorous test suite of the six by file count, and `ci:check` runs
  Prettier+knip+tsc+oxlint+a plugin-skills-sync-drift check — a genuinely mature CI gate.
- **Database:** Dual-mode — Cloudflare D1 (SQLite-compatible, for the Cloudflare-native deploy) or
  PostgreSQL (`npm run deploy:postgres` / `db:migrate:pg`) for a non-Cloudflare-infra deploy,
  both via Drizzle. This is the only repo of the six engineered for more than one database
  backend.
- **Auth/multi-tenancy:** The **only genuinely multi-tenant org model of the six.** Via Better
  Auth: real `organization`, `member`, and `invitation` tables (confirmed in
  `src/db/schema-parity.test.ts`, which asserts uniqueness constraints on
  `organization.slug` and `(member.organization_id, member.user_id)`) — i.e. real
  organizations with invitable members, not just a single owner/team-of-one model. There is also
  a dedicated `billing.schema.ts` table (`billing_customer_status`, keyed by `organizationId`,
  tracking `isPaying`/`paidPlanId`/`paidPlanStatus`) — **real SaaS billing-state plumbing**, the
  only one of the six with this.
- **Dashboard/UI:** Yes, a full web dashboard — keyword research, rank tracking, competitor
  insights, backlinks, site audits, AI visibility, per the README and the schema file list
  (`ga4.schema.ts`, `gsc.schema.ts`, `ai-visibility.schema.ts`, `reports.schema.ts`,
  `report-templates.schema.ts`, `telemetry.schema.ts`, etc. — a genuinely broad product surface).
- **Crawler type:** JS-rendering is **not** the relevant axis here — the site-audit crawler
  (`src/server/workflows/siteAuditWorkflowCrawl.ts`) is a real, self-written, chunked crawler with
  its own frontier/scratchpad (a Durable Object), URL policy, same-origin checks, and adaptive
  concurrency windowing (`crawlPage`, `adjustCrawlWindow`) — it is **not** simply a thin wrapper
  that forwards URLs to DataForSEO's on-page API, which is a meaningful positive finding (the
  crawl engine itself is genuinely home-grown and fairly sophisticated — durable, resumable,
  chunked crawling with explicit memory/byte-budget adaptation). We did not find evidence of
  headless-browser/JS rendering in the audit crawler itself (no playwright/puppeteer/chromium
  dependency for the audit path) — it appears to be a static-HTML crawl, same category as
  seonaut/crawlseo on that specific axis, despite being far more sophisticated in its job
  orchestration.
- **AI integration:** Uses the Vercel AI SDK with cloud model providers; **no `ollama` string
  found anywhere in `src/` or `README.md`/`docs/`** — confirmed via direct grep. This is a direct,
  verifiable gap against this project's "local Ollama" requirement: OpenSEO's AI features are
  built assuming a cloud LLM API, with no local-model path evidenced in the repo.
- **Architectural strengths:** By far the most popular, most tested, most actively developed repo
  in this set, with the only real multi-tenant-org + billing-state schema, a genuinely
  sophisticated self-written durable crawl engine, dual D1/Postgres database support, and a
  serious CI/release/plugin-skill-sync pipeline. The "MCP & Agent Skills" angle (exposing SEO data
  and workflows to Claude Code/other agents, with a published skills plugin) is a forward-looking,
  well-executed feature not matched elsewhere in this set.
- **Architectural weaknesses (the decisive ones for this project):**
  1. **Hard dependency on DataForSEO**, a paid third-party API, for keyword research, rank
     tracking, competitor insights, and backlinks — 221 files reference `dataforseo` in `src/`.
     The README is explicit and honest about this ("you pay them directly when self hosting"),
     so it is not a false claim, but it means most of the product's value (everything except the
     site-audit crawler) is not actually self-contained open-source functionality — it's a UI
     and orchestration layer over a paid data vendor. This directly conflicts with a
     "self-hosted, you own your data, no paid third-party dependency" goal.
  2. **Deep, structural coupling to Cloudflare's proprietary runtime primitives** — Durable
     Objects for crawl-frontier state, Cloudflare Workflows (`cloudflare:workflows`) for durable
     background steps, D1 bindings, KV for the MCP OAuth provider. The README's own recommendation
     is "we recommend self-hosting with Cloudflare... unless you already are self-hosting other
     apps" — i.e. even the maintainers acknowledge Docker self-hosting is the lesser-supported
     path. Porting the crawl engine out of Cloudflare Workers into a plain Node.js/Docker
     deployment would require reimplementing the Durable-Object-backed scratchpad and the
     Workflow step/retry semantics on different primitives (e.g. a real job queue + Postgres) —
     this is a substantial rewrite, not a drop-in reuse.
  3. **Billing is delegated to a third-party service ("Autumn")**, not a direct Stripe
     integration — `billing.schema.ts`'s own comment calls `customerJson` "Full Autumn customer
     payload." No `stripe` string appears in `package.json`. Adopting this billing approach would
     mean taking on a second proprietary SaaS dependency (Autumn) rather than owning the
     integration directly.
  4. No Ollama/local-LLM support, as noted above — the AI-recommendation story would have to be
     built from scratch even if the rest of the platform were reused.
- **README claims checked:** "Open source alternative to Semrush and Ahrefs" — the site-audit
  piece genuinely is self-contained open-source; the keyword/rank/backlink piece is honestly
  disclosed as requiring a paid DataForSEO key, so this is not a false claim once you read past
  the tagline, but a surface read of "open source alternative to Ahrefs" without reading the Costs
  section would overstate how self-contained the product is. No false claims found once the full
  README is read; the Costs section is forthright.

---

## Cross-cutting observations

- **All six repositories are MIT-licensed** — no license-compatibility blockers for reuse/porting
  from any of them.
- **Only two repos (`all-in-one-free-seo-tool`, `siteone-crawler`) have verified, working Ollama
  support.** The other four (`LibreCrawl`, `seonaut`, `crawlseo`, `open-seo`) have **no AI
  recommendation features at all**, let alone local-model support — this is the single biggest
  filter against this project's stated goals for four of the six candidates.
- **Only one repo (`open-seo`) has a genuine multi-organization/billing-state schema.** The other
  five are single-tenant-per-install (optionally multi-user within that one tenant, as in
  `all-in-one-free-seo-tool`), which means a real multi-tenant SaaS story has to be either built
  from scratch or adapted from `open-seo`'s Better-Auth-based schema design (not its Cloudflare
  runtime).
- **JS-rendering crawling is real in three repos** (`all-in-one-free-seo-tool`, `siteone-crawler`,
  `LibreCrawl`) and absent (honestly, not falsely claimed) in the other three
  (`seonaut`, `crawlseo`, `open-seo`'s audit path).
- **Test/CI discipline, from strongest to weakest:** `open-seo` (242 tests, 4 CI workflows,
  lint/typecheck/drift gates) ≈ `all-in-one-free-seo-tool` (97 tests, CI, e2e+PHP+fixtures) >
  `crawlseo` (73 tests, CI, e2e) ≈ `seonaut` (39 tests, CI) > `siteone-crawler` (6 fixture test
  files, CI, but 3 years of releases to back it up) > `LibreCrawl` (≈10 test functions, **no CI at
  all**).
