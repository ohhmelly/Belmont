# Security Review (Phase 7)

Date: 2026-10-25. Scope: everything under `seo-platform/app/` plus
`seo-platform/docker-compose.yml` and both `Dockerfile`s, as they stood
after Phase 6's merge (`624cb8b`). This review was done by actually
reading the code, running real commands, and writing real regression
tests — not by inference from the implementation plan's own summaries.
Every "Fixed" item below has a passing test or a reproducible command
cited next to it; every "Known gap" is left exactly that, not papered
over.

Baseline confirmed before any change: `npx vitest run` → **173 passed, 2
skipped (175), exit 0** — matches the number Phase 6 reported, so this
review started from the state that phase actually left behind.

---

## 1. Dependency vulnerability scan

**Before:**

```
npm audit
5 vulnerabilities (4 moderate, 1 high)
```

- `body-parser 2.0.0–2.3.0` (**high**) — DoS via trailing bytes after a
  compressed request body (GHSA-27r3-jxmh-p828).
- `esbuild <=0.24.2` (**moderate**, ×4 advisory entries for the same
  root cause at different depths) — esbuild's dev server accepts
  cross-origin requests (GHSA-67mh-4wv8-2f99).

**Root-cause investigation, not just `npm audit fix`:**

`body-parser` turned out to be pulled in by **`express`**, which was a
direct dependency in `app/package.json` — but `grep -rn "from [\"']express[\"']"
src/` found **zero** imports of it anywhere in the app's own source.
`npm ls express` confirmed it was an orphaned leftover (most likely from
an earlier scaffold or a cross-contamination during the two-session
Phase 6 merge) with nothing in this app actually using it. Fix: removed
`express` from `app/package.json` entirely (`npm uninstall express`) —
this is dependency hygiene *and* the actual fix for the high-severity
finding, not a version bump.

`esbuild` is pulled in transitively by `drizzle-kit` (a **devDependency**
only — `drizzle-kit generate`/`drizzle-kit migrate`, never imported by
the running app or worker) via the deprecated `@esbuild-kit/esm-loader`
package, which pins an old `esbuild` internally regardless of
`drizzle-kit`'s own direct `esbuild` dependency (which is already a safe
`^0.25.4`). Checked whether a newer `drizzle-kit` fixes this:
`npm view drizzle-kit dist-tags` shows `latest: 0.31.11`, which is
exactly what's already installed — there is no newer *stable* release
that drops `@esbuild-kit/esm-loader`. `npm audit fix --force`'s only
offer is to **downgrade** to `drizzle-kit@0.18.1`, a major regression
(13 minor versions back) for a dev-only tool, to fix a vulnerability in
a feature (`esbuild serve`) this project's `drizzle-kit` usage never
invokes (`drizzle-kit generate`/`migrate` use esbuild as a bundler
library, not as an HTTP dev server). Decision: **not forced** — the
real-world exposure is effectively nil (dev-only, feature never
invoked, requires an attacker-controlled page open in a developer's
browser while `drizzle-kit`'s *own* dev-server mode is running, which
this project never starts), and the "fix" would trade a theoretical
dev-time risk for a real regression in migration tooling. Tracked here
as an accepted, documented risk — revisit when `drizzle-kit` ships a
stable release that drops the legacy loader.

**After:**

```
npm audit fix
npm audit
4 vulnerabilities (4 moderate), 0 high, 0 critical
```

All 4 remaining are the one esbuild/drizzle-kit chain described above,
all moderate, all dev-only. `npm audit fix` (non-breaking) found nothing
else to change once `express` was gone.

**Regression check after the dependency change:** full suite re-run
(188 passed, 2 skipped — see §6), `npx tsc --noEmit` clean, `npm run
build` exit 0, `npx eslint .` clean (0 errors). Removing an unused
dependency, as expected, broke nothing.

---

## 2. Auth / session security review

**Session config** (`src/lib/auth.ts`, Better Auth defaults — read
directly from `node_modules/better-auth/dist/context/create-context.mjs`
and `dist/cookies/index.mjs`, not assumed):

| Setting | Value | Assessment |
|---|---|---|
| Session `expiresIn` | 7 days | Reasonable default, not overridden; fine for this app's risk profile. |
| Session `updateAge` (rolling refresh) | 1 day | Sensible — a session used daily never expires; one abandoned for a week does. |
| Cookie `httpOnly` | always `true` | Correct — not configurable off. |
| Cookie `sameSite` | `"lax"` | Correct default for a same-site app with no cross-site POST flows needed. |
| Cookie `secure` | `true` when `BETTER_AUTH_URL` is `https://` or `NODE_ENV=production` | Correct **as long as** `BETTER_AUTH_URL` is set to the real `https://` origin in production — this is a deployment-time responsibility (see `DEPLOYMENT.md`, Phase 8), not something to hardcode here. |

No changes made here — the defaults are sound for this app's shape.
Documented explicitly rather than left as "presumably fine," per this
phase's brief.

**Password reset — found as a real gap, then fixed (not just
documented):**

Before this phase, `src/lib/auth.ts` never configured
`emailAndPassword.sendResetPassword`, so Better Auth's own
`/request-password-reset` endpoint returned `RESET_PASSWORD_DISABLED`
for every request — there was **no way** for a locked-out user to get
back into their account. Better Auth already ships the actual
token-generation/expiry/single-use-consumption logic
(`/request-password-reset`, `/reset-password/:token`, `/reset-password`
routes in the library itself); it only needed the delivery callback
wired up. Fixed minimally, reusing Phase 5's existing optional-SMTP
`sendEmailNotification` helper (`src/lib/notifications/email.ts`) rather
than building new email infrastructure:

- `src/lib/auth.ts`: `emailAndPassword.sendResetPassword` now sends the
  reset link through `sendEmailNotification` (no-ops cleanly, same as
  Phase 5's crawl notifications, when `SMTP_URL` is unset — logged, never
  thrown).
- `src/app/forgot-password/page.tsx` (new): email → `requestPasswordReset`.
- `src/app/reset-password/page.tsx` (new): token (from the emailed link's
  redirect) + new password → `resetPassword`.
- `src/app/login/page.tsx`: added a "Forgot password?" link.

**Proof, not assertion** — `src/lib/auth-password-reset.test.ts` (3
tests, all passing) against the real `auth` instance and real Postgres:
a real token is created, consuming it actually changes the stored
password (old password then fails sign-in, new one succeeds), the token
is single-use (reuse rejected), and an unknown email gets the identical
generic response with **no** verification row created (no
account-enumeration oracle).

**Known gap, explicitly scoped out:** this is deliberately minimal (no
"resend," no rate-limit-aware UI messaging beyond the generic Better
Auth 429, no branded email template). A full UX pass on this flow is
reasonable future work but out of scope for a security-focused phase —
the mechanism itself is real and tested, not a stub.

**Rate limiting on auth endpoints — found as a real gap, then fixed:**

Better Auth ships a built-in IP-keyed rate limiter
(`node_modules/better-auth/dist/api/rate-limiter/index.mjs`) with a
strict built-in rule for `/sign-in` and `/sign-up` (**3 requests per
10s**) and for password-reset-type endpoints (**3 per 60s**) — exactly
the brute-force protection this app needs, with zero added dependency
(in-memory bucket, correct for this single-instance deployment target;
no Redis). The problem: it only turns itself on by default when
`NODE_ENV === "production"` (`enabled: options.rateLimit?.enabled ??
isProduction`) — an **implicit** dependency that was silently off in
this repo's own dev `.env` (`NODE_ENV=development`) and in every test
run. Fixed: `src/lib/auth.ts` now sets `rateLimit: { enabled: true }`
explicitly, so it's never accidentally off regardless of environment.

**Proof** — `src/app/api/auth/rate-limit.test.ts` calls the *real*
exported route handler (`POST` from `./[...all]/route.ts`, the exact
function Next.js invokes for a real request) with real `NextRequest`s:
repeated sign-in attempts from one client IP get a 429 with
`X-Retry-After` after the built-in budget is used, and a different
client IP gets its own independent budget. **Verified this is a real
fix, not a vacuous pass**: temporarily set `rateLimit.enabled: false`
and re-ran the same test — it failed (no 429 ever returned); restored
the fix and re-ran — passed again.

**Configuration caveat for production, documented rather than
hardcoded:** Better Auth's IP resolution (`getIP()` in
`@better-auth/core`) only trusts `x-forwarded-for` when it resolves to a
single, valid, parseable IP, and does **not** trust it in production by
default beyond that basic parse — there's no `trustedProxies` CIDR list
configured here, because this app has no reverse proxy configured in
this repo (that's the real Linux target's job, per the task's own
framing). **Before this goes live behind a reverse proxy**, whoever
deploys it must either ensure the proxy sends a single, correct
`x-forwarded-for` (the default header Better Auth reads) or configure
`advanced.ipAddress.trustedProxies`/`ipAddressHeaders` to match — without
that, IP resolution can be spoofed by a malicious client's own header,
or (if the proxy doesn't forward a real IP at all) every real user could
share one rate-limit bucket. This is a deployment-time configuration
step, not a code defect, so it isn't hardcoded here — flagging it for
`DEPLOYMENT.md` (Phase 8).

**Rate limiting on expensive actions — found as a real gap, then
fixed:**

Better Auth's rate limiter only covers its own `/api/auth/*` HTTP
routes — it does nothing for this app's Server Actions, including
`triggerCrawl`/`addWebsite` (each spawns a real `siteone-crawler`
subprocess on the worker). Phase 6's monthly quota
(`assertCanRunManualCrawl` in `billing/quota.ts`) blocks exceeding a
plan's *monthly* crawl allowance, but does nothing to stop a burst of
rapid-fire triggers within that same month's budget — e.g. a script
hammering "Run crawl" 50 times in a second, each spawning a subprocess,
all still "allowed" by the monthly counter.

Fixed with a new, deliberately simple module:
**`src/lib/rate-limit.ts`** — an in-memory, per-process fixed-window
limiter (no Redis/Postgres — correct for this single-instance,
self-hosted deployment target, matching the same reasoning the project
already applied to pg-boss not needing Redis). Wired into
`addWebsite` and `triggerCrawl` in `src/app/dashboard/actions.ts`: **10
manual crawl triggers per 60 seconds per user** — generous for any real
workflow, bounding worst-case abuse.

**Proof** —
`src/app/dashboard/manual-crawl-rate-limit.test.ts` (2 tests, real
Postgres, real pg-boss enqueue, real sessions via
`test-support/auth-fixtures.ts`), deliberately run on the **Starter**
plan (`manualCrawlsPerMonth: null`, i.e. unlimited) specifically so the
monthly quota can never be what blocks the 11th call — only the new
burst limiter can, and does: the first 10 `triggerCrawl` calls in a
user's window succeed, the 11th is rejected with a "Too many requests"
error and creates no 11th `crawl_jobs` row; a different user gets an
independent budget.

---

## 3. CSRF / input validation / injection review

- **Server Actions' Origin-header CSRF protection**: `next.config.ts`
  has no `experimental.serverActions.allowedOrigins` override and
  nothing disables the built-in check — confirmed by reading the file
  directly. Untouched, as instructed.
- **Non-Server-Action POST routes**:
  - `POST /api/webhooks/stripe` — authenticated by Stripe's own webhook
    signature (verified via Stripe's SDK inside the active
    `BillingProvider`), never by a session; reads the raw body as
    text/bytes (not `req.json()`) so the exact signed bytes are verified.
    Confirmed unchanged from Phase 6 and still covered by
    `src/app/api/webhooks/stripe/route.test.ts`.
  - `GET/POST /api/auth/[...all]` — Better Auth's own handler; each
    sub-route does its own validation (password checks, session
    issuance, etc.) and is now also rate-limited (§2).
  - `GET /api/health` — no auth needed by design (health probe); leaks
    nothing beyond `{status, db}`.
  - `GET /api/reports/[id]` — session- **and** org-ownership-gated via
    `requireReportAccess` (Phase 6), confirmed by reading the route
    directly; unchanged.
- **SQL injection**: grepped the whole `app/src` tree for raw/interpolated
  SQL (`sql\`` template usage, `pool.query`, `db.execute`). Found exactly
  one production use of `sql` outside Drizzle's query builder:
  `src/app/api/health/route.ts`'s `sql\`select 1\`` — a hardcoded
  literal with **no** user input anywhere near it. Every other
  production data-access path goes through Drizzle's parameterized
  query builder (`.where(eq(...))`, `.insert().values(...)`, etc.),
  never raw string concatenation. `pool.query` with `$1`-style
  parameterized placeholders appears only in test cleanup helpers
  (`billing-quota.integration.test.ts`,
  `manual-crawl-rate-limit.test.ts`), also safely parameterized and
  never fed external input. **No SQL injection risk found.**
- **XSS in the HTML report / dashboard** — reviewed `src/lib/reports/html.ts`
  line by line: every interpolated field (finding title/description/
  category/url, AI-recommendation title/body, website URL, org name,
  history sample titles/urls) already goes through a local `escapeHtml()`
  consistently. The dashboard page
  (`src/app/dashboard/websites/[id]/page.tsx`) renders all of this
  through plain JSX `{...}` expressions with **no** `dangerouslySetInnerHTML`
  anywhere in the codebase (`grep -rn dangerouslySetInnerHTML src/` is
  empty) — React auto-escapes those by default. **Verified, not just
  trusted**: added `src/lib/reports/html.test.ts` (3 tests) with a
  `<script>alert(1)</script>` payload in every one of those fields;
  asserts the raw payload never appears in the rendered HTML and the
  escaped form does. **Proved the test is load-bearing**, not vacuous:
  temporarily removed one `escapeHtml()` call in `html.ts` — the test
  failed immediately — then restored it and re-ran clean.
- **CSV formula injection (CWE-1236) — found as a new issue, fixed**:
  `src/lib/reports/csv.ts` escaped commas/quotes/newlines correctly
  (RFC4180) but did nothing about a cell value that happens to start
  with `=`, `+`, `-`, or `@` — which crawled page titles (fully
  attacker-controlled, since the page owner writes their own `<title>`)
  can trivially contain. Opening such a CSV in Excel/Sheets/LibreOffice
  evaluates that cell as a **formula**, not text (e.g.
  `=HYPERLINK("http://evil.example","click")` or an old-Excel DDE
  payload) — a real, documented (OWASP) class of injection distinct
  from HTML XSS. Fixed with the standard mitigation: prefix any field
  starting with a formula-trigger character (`=`,`+`,`-`,`@`, tab, CR)
  with a single quote before CSV-quoting, so spreadsheet apps render it
  as a literal string. Proven in `src/lib/reports/csv.test.ts` (8
  tests): classic formula payloads are neutralized, ordinary titles are
  left untouched, and the neutralization composes correctly with
  existing comma/quote CSV-escaping.

---

## 4. Secrets / configuration review

- Grepped the whole `seo-platform/` tree for hardcoded credentials/keys
  (`sk_live_`, `rk_live_`, AWS key patterns, PEM private key headers,
  inline `password: "..."` literals). The only hit was
  `src/lib/test-support/auth-fixtures.ts`'s `"test-password-123456"` —
  a clearly-labeled test fixture, not a real credential.
- `.env` (both `seo-platform/app/.env` and the standalone build's copy
  under `.next/standalone/.env`) is **not** tracked in git — confirmed
  directly with `git ls-files | grep '\.env$'` (empty) and
  `git check-ignore -v`, which shows `app/.gitignore`'s `.env*` rule
  (with an explicit `!.env.example` exception) is what excludes it.
- Both `.env.example` files (`seo-platform/.env.example` and
  `seo-platform/app/.env.example`) contain only placeholders — read
  directly, not assumed. The Stripe section explicitly documents the
  `sk_test_`-only guard and warns against live keys.
- **Docker build-context leak — found as a real gap, fixed**:
  `Dockerfile.worker`'s build *context* is the **repo root** (`.`), not
  `./app` (documented reason: it also needs `vendor/siteone-crawler/`,
  a sibling of `app/`). The repo root had **no `.dockerignore` at all**,
  meaning `docker build` sent the entire repo — `app/node_modules`,
  `.git` history, `fixtures/node_modules`, and critically
  **`app/.env`** (real local secrets in a dev checkout) — to the Docker
  daemon as build context on every build. The worker Dockerfile's own
  `COPY` instructions are selective enough that none of this ever lands
  in an image *layer*, but sending a real `.env` to the daemon at all is
  unnecessary exposure, and the `node_modules`/`.git` bloat was a real
  build-time cost for no benefit. Fixed: added `seo-platform/.dockerignore`
  excluding `node_modules`, `.git`, `.next`, `.env*` (except
  `.env.example`), logs, and the reports storage directory.
- **Containers running as root — found as a real gap, fixed**: neither
  `app/Dockerfile` nor `app/Dockerfile.worker` had a `USER` directive —
  both ran as root inside their containers. The worker is the
  higher-risk of the two (it spawns the `siteone-crawler` binary against
  externally-controlled, if SSRF-validated, URLs). Fixed both: each now
  creates an unprivileged user (`nextjs` / `worker`, uid/gid 1001),
  `chown`s the directories that process needs to write to (the app
  writes PDF/HTML/CSV/JSON report files to `./storage/reports` **from
  the app process itself**, not only the worker — confirmed by reading
  `src/lib/reports/generate.ts` and tracing the call from
  `dashboard/actions.ts`'s `generateReport`), and ends with `USER
  <name>` before the `CMD`.
  **Honest verification gap**: this sandbox has no usable Docker daemon
  (`docker info` fails even after attempting `dockerd` directly —
  `ulimit: error setting limit (Operation not permitted)`, consistent
  with a container-in-container restriction), so these Dockerfile
  changes were reviewed by reading them carefully and following the
  standard, widely-used Next.js-standalone non-root pattern, but **were
  not verified with an actual `docker compose build`** in this phase.
  `docker compose config` (pure YAML/compose-spec parsing, no daemon
  needed) does succeed and correctly resolves the new `deploy.resources.limits`
  blocks. This should be spot-checked with a real `docker compose up
  --build` on a machine with a working Docker daemon before relying on
  it in production — flagging this exactly the way Phase 2/3 flagged
  their own un-buildable-in-sandbox Docker gaps, rather than silently
  claiming it works.
- **Exposed ports**: `postgres` (5432), `app` (3000), and `ollama`
  (11434) are all bound to `127.0.0.1` only, never `0.0.0.0` — confirmed
  by reading `docker-compose.yml` directly; this was already correct
  from Phase 2 and untouched. `worker` has no published port at all
  (`expose: "3001"` only, reachable over the internal Compose network
  for its health check, never from the host). **For the real Linux
  production target**: putting a TLS-terminating reverse proxy (nginx/
  Caddy/Traefik) in front of the `app` service's `127.0.0.1:3000` is the
  deployment's job, not this repo's — noted here rather than hardcoded,
  consistent with the task's framing. That reverse proxy must forward a
  trustworthy client IP header for the rate limiter to work correctly
  per-client (§2's caveat).
- **Resource limits — found as a real gap, fixed**: no service had a
  memory/CPU ceiling. Added conservative `deploy.resources.limits`
  (honored by `docker compose up` directly since Compose V2, not just
  Swarm) to every service: Postgres and the app at 1 CPU/1GB, the
  worker (which runs real crawler subprocesses, `WORKER_CONCURRENCY=2`
  by default) at 2 CPU/2GB, Ollama at 2 CPU/4GB (commented as
  model-size-dependent — tune to whatever model is actually pulled).
  These are reasonable starting points for a small self-hosted box, not
  load-tested against the real Dell server target — noted for
  `DEPLOYMENT.md` to revisit with real numbers.
- `BETTER_AUTH_SECRET` in `docker-compose.yml` falls back to
  `dev-only-placeholder-secret-not-for-prod` if the environment variable
  isn't set. This is pre-existing (Phase 2) dev convenience, already
  named honestly in its own default string, not something this phase
  introduced — flagging again here as a reminder: **a real deployment
  must set a real `BETTER_AUTH_SECRET`** (and a real `BETTER_AUTH_URL`
  starting with `https://`, per §2) via its own `.env`, never rely on
  this fallback.

---

## 5. API access / endpoint audit

Every `route.ts`, every `"use server"` action, and every page that
reads session-scoped data, enumerated by `find`/`grep`, not by
sampling. ✅ = confirmed correctly gated or intentionally public by
reading the code directly (not inferred from a comment).

| Endpoint / action | File | Gating | Status |
|---|---|---|---|
| `GET /api/health` | `api/health/route.ts` | None (intentional — health probe, no data) | ✅ intentionally public |
| `GET,POST /api/auth/[...all]` | `api/auth/[...all]/route.ts` | Better Auth's own per-route logic (sign-in/up/out/session/etc.); now also IP rate-limited (§2) | ✅ |
| `POST /api/webhooks/stripe` | `api/webhooks/stripe/route.ts` | Stripe signature verification (no session — correct, Stripe calls this server-to-server) | ✅ intentionally public, signature-gated |
| `GET /api/reports/[id]` | `api/reports/[id]/route.ts` | `requireReportAccess` (session + org ownership via the report's website) | ✅ |
| `addWebsite` | `dashboard/actions.ts` | `requireActiveOrg` + plan quota + burst rate limit (new, §2) + SSRF validation | ✅ |
| `triggerCrawl` | `dashboard/actions.ts` | `requireWebsiteAccess` + plan quota + burst rate limit (new, §2) | ✅ |
| `cancelCrawl` | `dashboard/actions.ts` | `requireCrawlJobAccess` (org ownership via the job's website) | ✅ |
| `setWebsiteSchedule` | `dashboard/actions.ts` | `requireWebsiteAccess` + plan quota (scheduling gate) | ✅ |
| `markNotificationRead` | `dashboard/actions.ts` | `requireNotificationAccess` | ✅ |
| `verifyWebsite` | `dashboard/actions.ts` | `requireWebsiteAccess` | ✅ |
| `generateReport` | `dashboard/actions.ts` | `requireWebsiteAccess` + plan gate (AI recommendations) | ✅ |
| `deleteWebsite` | `dashboard/actions.ts` | `requireWebsiteAccess` with `minRole: "admin"` | ✅ |
| `inviteMemberAction` | `dashboard/actions.ts` | `requireActiveOrg` + Better Auth's own `organization` plugin permission statement (member role has no `invitation:create`) | ✅ |
| `changeMemberRoleAction` | `dashboard/actions.ts` | `requireActiveOrg` + Better Auth's own permission statement | ✅ |
| `changePlan` | `dashboard/billing/actions.ts` | `requireActiveOrg(..., "admin")` | ✅ |
| `openBillingPortal` | `dashboard/billing/actions.ts` | `requireActiveOrg(..., "admin")` | ✅ |
| `/` (home) | `app/page.tsx` | None (marketing shell, no data) | ✅ intentionally public |
| `/login`, `/register` | `app/login,register/page.tsx` | None (must be reachable unauthenticated) | ✅ intentionally public |
| `/forgot-password`, `/reset-password` (new) | `app/forgot-password,reset-password/page.tsx` | None (must be reachable unauthenticated); underlying Better Auth endpoints are rate-limited and token-gated | ✅ intentionally public |
| `/dashboard` | `dashboard/page.tsx` | Session check, redirects to `/login` if absent | ✅ |
| `/dashboard/audit-log` | `dashboard/audit-log/page.tsx` | Session check + explicitly scoped to the caller's own `activeOrg.id` (never a URL-supplied org id) | ✅ |
| `/dashboard/billing` | `dashboard/billing/page.tsx` | Session check | ✅ |
| `/dashboard/websites/[id]` | `dashboard/websites/[id]/page.tsx` | `loadWebsiteDetail` → org-ownership check; 403/404 both render as `notFound()` (never confirms another org's resource exists) | ✅ |

**No endpoint found that should be gated but isn't.** This matches the
spirit of Phase 6's tenant-isolation fix: this was the first priority
checked, and nothing new turned up requiring an emergency fix the way
Phase 6's original gap did.

---

## 6. Full regression pass

Run after every change in this phase, not just once at the end:

- `npx vitest run` → **191 passed, 2 skipped (193), exit 0** — 30 test
  files (up from 25; 18 new tests added this phase: 3 HTML-escaping, 8
  CSV-injection, 2 auth rate-limit, 2 manual-crawl burst-limit, 3
  password-reset; 173 + 18 = 191. See `TEST_RESULTS.md` for the exact
  file-by-file breakdown).
- `npx tsc --noEmit` → clean, exit 0.
- `npx eslint .` → **0 errors**, 4 pre-existing warnings (unused
  destructured params in two files this phase never touched —
  `src/lib/ai/recommendation-engine.test.ts`,
  `src/lib/billing/mock-provider.ts` — confirmed pre-existing by
  `git diff`, not introduced here).
- `npm run build` → exit 0; all 13 routes present including the two new
  ones (`/forgot-password`, `/reset-password`).

See `docs/TEST_RESULTS.md` for the full breakdown and what each test
category actually proves.

---

## Summary of fixes made this phase

1. Removed the unused `express` dependency → eliminated the only
   high-severity `npm audit` finding.
2. Documented (not forced) the remaining 4 moderate `esbuild`/
   `drizzle-kit` dev-only advisories, with reasoning for why forcing the
   fix is riskier than the finding itself.
3. Made Better Auth's rate limiter explicitly `enabled: true` (was
   implicitly tied to `NODE_ENV`), protecting `/sign-in`, `/sign-up`,
   and the new password-reset endpoints at the library's own strict
   built-in rates.
4. Built a real password-reset flow (`sendResetPassword` wiring + two
   new pages), where none existed before.
5. Added a per-user burst rate limiter (`src/lib/rate-limit.ts`) on
   manual crawl triggering, independent of the existing monthly quota.
6. Fixed CSV formula injection in `src/lib/reports/csv.ts`.
7. Verified (and added a regression test for) existing HTML-escaping
   correctness in the report generator — no vulnerability found there,
   but now proven, not just trusted.
8. Added a root-level `.dockerignore` to stop the worker image's build
   context from including `node_modules`, `.git`, and real `.env` files.
9. Added a non-root `USER` to both `Dockerfile` and `Dockerfile.worker`.
10. Added `deploy.resources.limits` (CPU/memory) to every service in
    `docker-compose.yml`.
11. Completed a full endpoint/action audit (§5) — found everything
    already correctly gated; no new tenant-isolation gap found.

## Known gaps (carried forward, not silently dropped)

- Password-reset flow is minimal (no resend throttling UI, no branded
  email, no rate-limit-specific messaging) — real and tested, not
  polished.
- The in-memory rate limiters (both Better Auth's own and the new
  burst limiter) reset on process restart and don't share state across
  multiple app instances — correct for this project's explicit
  single-instance self-hosted target, but would need a shared store
  (Postgres- or Redis-backed) if this ever runs more than one app
  instance.
- Better Auth's IP resolution needs a correctly configured reverse
  proxy (or explicit `trustedProxies`) in production to key rate limits
  per real client rather than per shared bucket — a deployment
  configuration step, not a code defect; flagged for `DEPLOYMENT.md`.
- Docker non-root/`.dockerignore`/resource-limit changes were reviewed
  by reading the files, not verified with an actual `docker compose
  build`/`up` — no usable Docker daemon in this sandbox. Needs a
  spot-check on a real machine before relying on it in production.
- The 4 remaining moderate `npm audit` findings (esbuild via
  drizzle-kit's deprecated `@esbuild-kit/esm-loader`) are accepted,
  dev-only, and not forced-fixed — see §1 for the full reasoning.
- `BETTER_AUTH_URL`/`BETTER_AUTH_SECRET` production values (real
  `https://` origin, a real random secret) are deployment-time
  responsibilities this review can only flag, not enforce from inside
  the repo.
