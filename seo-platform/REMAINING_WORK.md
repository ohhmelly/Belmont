# Remaining Work

Status as of **2026-10-25, Phase 8 (final planned phase)**. This
supersedes the scattered "known gaps" notes in `IMPLEMENTATION_PLAN.md`
(those stay as the historical record of what each phase found, and are
not edited after the fact) — this file is the current, consolidated
punch list. Nothing here is hidden or downplayed.

This revision pulls together every open item from every phase's "known
gaps" section (Phases 2 through 7) plus this file's own earlier entries,
drops the ones Phase 7/8 actually closed, and adds what Phase 8 itself
found. Ordered **security-relevant gaps first, then functional gaps,
then polish**, per the project's own working agreement.

## Project direction (2026-10-22, unchanged)

The project owner has decided this is **their own internal tool for
fulfilling freelance (Fiverr-style) SEO audit gigs, not a public
multi-tenant SaaS.** This deprioritizes going live with Stripe, public
sign-up hardening, and org-vs-org edge cases beyond what's already
fixed. It raises the priority of report output quality and having the
stack reliably runnable on demand. Phase 8 (deployment prep) is the
project's last planned phase per `IMPLEMENTATION_PLAN.md` — everything
below is what's left *after* it, for whoever picks this up next, not
blocking items for a phase still to come.

---

## Closed since the last revision of this file (2026-10-22 → now)

Listed here explicitly so it's clear these are no longer open, not
silently dropped:

- **No password-reset flow** → fixed Phase 7 (Better Auth
  `sendResetPassword`, account-enumeration-safe).
- **Better Auth rate limiter implicitly off in dev** → fixed Phase 7
  (explicit `enabled: true`).
- **No rate limiting on manual crawl triggering beyond monthly quota** →
  fixed Phase 7 (`src/lib/rate-limit.ts` per-user burst limiter).
- **CSV formula injection (CWE-1236)** → fixed Phase 7, 8 tests.
- **Docker images ran as root** → fixed Phase 7 (non-root `USER` in both
  Dockerfiles).
- **No per-service resource limits in `docker-compose.yml`** → fixed
  Phase 7 (`deploy.resources.limits` on all services).
- **`npm audit`: 1 critical/high (`express`, unused)** → fixed Phase 7
  (dependency removed outright).
- **Report-download route had no per-org ownership check** (flagged
  since Phase 4) → fixed in Phase 6's tenant-isolation work
  (`requireReportAccess`).
- **Docker build/compose never actually verified by a real daemon**
  (carried since Phase 2) → **verified for real in Phase 8** — see
  `docs/DEPLOYMENT.md` §1. A real `docker compose build` + `up -d`
  brought up `postgres`/`app`/`worker` all healthy, `/api/health` and
  the worker's `/healthz` both confirmed live through the containers.
- **Worker's Docker image had never actually been built** (Phase 3) →
  built and run successfully in Phase 8.
- **Production reverse-proxy/HTTPS guidance "flagged for
  `DEPLOYMENT.md`"** (Phase 7) → written in Phase 8, with syntactically
  validated Caddy and nginx examples (`docs/DEPLOYMENT.md` §11).

## New gap found and fixed in Phase 8

- **`app_reports` volume missing from `docker-compose.yml`** — generated
  report files (`/app/storage/reports` in the `app` container) had no
  named volume and would be silently lost on every container rebuild or
  recreate. Found while actually running the stack for the first time
  (something only possible once Docker itself worked); fixed and proven
  with a real recreate-and-check. See `docs/DEPLOYMENT.md` §1 and §5.

---

## Open gaps, prioritized

### Security-relevant

1. **Rate limiters are single-process, in-memory, by design.** Both
   Better Auth's own limiter and the per-user crawl-burst limiter keep
   state in process memory. Correct for this project's single-instance
   target; would silently under-enforce (effectively multiplying the
   real limit by replica count) if `app` is ever scaled to more than one
   replica. Needs a shared store (Redis- or Postgres-backed) before any
   multi-instance deployment. *(Phase 7, still open — now documented in
   `docs/DEPLOYMENT.md` §10, not yet fixed in code.)*
2. **Better Auth's IP-based rate limiting needs a correctly configured
   reverse proxy in front of it to key on real client IPs.** Guidance is
   now written (`docs/DEPLOYMENT.md` §11), but no reverse proxy is
   actually deployed anywhere — this is a "do this before/when you go
   live" item, not a code gap.
3. **4 moderate `npm audit` findings remain, accepted deliberately.**
   All trace to `drizzle-kit`'s dev-only `@esbuild-kit` loader (`esbuild
   <=0.24.2`, a dev-server-only issue never reachable at runtime).
   `npm audit fix --force` only offers a breaking downgrade to
   `drizzle-kit@0.18.1` — confirmed again in Phase 8 (`npm audit` run
   fresh: same 4 moderate, same proposed downgrade). Revisit when
   `drizzle-kit` ships a non-breaking fix.
4. **No live/test Stripe account has ever been exercised against the
   real Stripe API**, in any phase — only offline webhook signature
   verification is proven (Phase 6). Moot while billing stays in test
   mode per the project direction above, but a real gap if that ever
   changes.
5. **Server Action error messages are invisible to users in the
   production build.** `addWebsite`'s SSRF message, `QuotaError`
   messages, `setWebsiteSchedule`'s plan-gate message, etc. all throw a
   clear, intended message; Next.js redacts thrown Server
   Action/Component error text on the client in production by design,
   showing only a generic "Minified React error #441" + digest. The
   real message is logged server-side, so this is a UX/support gap, not
   a security leak — but it's user-facing breakage in the one build mode
   that's actually deployed. **Confirmed still unfixed in Phase 8**: no
   `useActionState` usage exists anywhere in `src/` (checked directly).
   Fix (unchanged from when this was first found, 2026-10-23): convert
   `addWebsite`, `triggerCrawl`, `setWebsiteSchedule`, `verifyWebsite`,
   `generateReport`, `cancelCrawl`, `markNotificationRead`,
   `changePlan`/`openBillingPortal` from throw-on-error to
   `useActionState`'s `{error: string} | {success: true}` return pattern.

### Functional

6. **JS-rendering (`--browser` mode) has never been exercised for
   real**, in any phase — no Chromium-family browser is available in
   this build sandbox, and **confirmed again in Phase 8**: neither the
   `app` nor `worker` Docker image bundles one. The adapter's
   fallback-to-static-crawl path is known to run cleanly without a
   browser, but real rendered-content detection is simply unverified.
   Needs a real run wherever Chromium is available.
7. **No single test proves the full chain** "scheduled crawl fires → new
   findings found → notification row written" end-to-end — each link
   (scheduling, diffing, notifying) is proven individually, not as one
   combined test. *(Phase 5, still open.)*
8. **Deleting a website with a crawl job still queued/retrying for it**
   leaves an orphaned pg-boss job that fails cleanly on an FK violation —
   a sane terminal state, not stuck, but not an elegantly handled case.
   *(Phase 5, still open.)*
9. **No org-switcher UI** — "active org" is still "first org returned
   for this user." *(Phase 6, still open; low priority given the
   single-operator-tool direction.)*
10. **A pre-existing flaky assertion** in
    `src/lib/reports/generate.test.ts:83` (`expect(rows.length).toBeGreaterThan(5)`)
    was observed to fail once under full-suite resource contention
    (2026-10-22), passing in isolation every time. It has not recurred
    in any full-suite run since, including Phase 8's own baseline run
    today (191 passed, 0 flakes) — but the assertion itself is unchanged,
    so the underlying timing sensitivity is presumably still there.
    Flagging again rather than assuming it's gone because it hasn't
    shown up recently.
11. **No log rotation/size cap configured** for Docker's `json-file` log
    driver on either service. Both `app` and `worker` log to stdout only
    (by design — see `docs/DEPLOYMENT.md` §7), but nothing currently caps
    how much disk that accumulates on a long-running production host.
    *(Found in Phase 8 while writing `docs/DEPLOYMENT.md`; a one-line
    `docker-compose.yml` or daemon-level fix, not done yet because it's
    an operational tuning choice for the real server, not a default this
    repo should impose.)*

### Polish

12. **Vendored crawler binaries are committed directly to git** (~38MB
    Linux + ~24MB Windows, confirmed current sizes in Phase 8) rather
    than fetched/built at image-build time. Acceptable for now, not
    great repo hygiene long-term. *(Phase 3, still open.)*
13. **The small 0.5B Ollama model occasionally produces lower-quality
    output** (e.g. echoing a prompt delimiter token literally) — a model-
    quality limitation, not a security issue, since no code path treats
    model text as anything but inert stored data. *(Phase 4, still open,
    not expected to be "fixed" so much as mitigated by using a larger
    model if quality matters more than footprint.)*
14. **The "premium UI/UX" design-system pass from the original project
    brief** (design tokens, Figma/Playwright/Chrome DevTools MCP
    integration if available, motion pass, visual QA, independent review)
    — **still entirely unstarted**, confirmed by `IMPLEMENTATION_PLAN.md`'s
    own "Additional Directive" checklist (every item unchecked). The app
    is a plain, functional, unstyled-beyond-defaults dark UI. Deliberately
    deprioritized by the project owner (2026-10-22 direction, above) in
    favor of report-output quality, which *did* get a real polish pass
    (category scores, SVG gauge, numbered sections, history chart —
    2026-10-22/23).

---

## Explicitly out of scope / not applicable

- Going live with real Stripe payments, public sign-up hardening beyond
  what's already fixed, and multi-tenant SaaS polish beyond the current
  tenant-isolation/audit-logging work — all deprioritized by the
  project owner's own direction, not abandoned due to difficulty.
- Actually deploying this anywhere publicly reachable — `docs/DEPLOYMENT.md`
  explains how; doing it is the project owner's own separate decision,
  consistent with this project's standing instruction.
