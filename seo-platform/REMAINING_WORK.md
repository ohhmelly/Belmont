# Remaining Work

Status as of 2026-10-22. This is the honest, consolidated list of what's
left, superseding the scattered "known gaps" notes in `IMPLEMENTATION_PLAN.md`
(those stay as the historical record of what each phase found; this file is
the current punch list). Nothing here is hidden or downplayed — see each
phase's commit history for full detail on how an item was found.

## Project direction (2026-10-22)

The project owner has decided this is **their own internal tool for
fulfilling freelance (Fiverr-style) SEO audit gigs, not a public
multi-tenant SaaS.** This deprioritizes (not removes — the code stays,
it's harmless unused) going live with Stripe, public sign-up hardening,
and org-vs-org edge cases beyond what's already fixed. It raises the
priority of report output quality (the actual client deliverable) and
having the stack reliably runnable on demand. Next planned work: a
design/polish pass on the PDF/HTML reports specifically (see
`docs/DESIGN_UPDATES.md` item 8), not deployment or further SaaS features.
Status 2026-10-23: that report-polish pass is done (category scores,
AI-crawler-visibility check, SVG gauge, numbered sections, history
chart) — see `IMPLEMENTATION_PLAN.md`'s "Report-polish pass" entry.

## New, real bug found 2026-10-23 (not yet fixed)

**Server-action error messages are invisible to users in the production
build.** Several places throw a clear, intentional, user-facing error —
`addWebsite`'s SSRF validation message, `src/lib/billing/quota.ts`'s
`QuotaError` messages, `setWebsiteSchedule`'s plan-gate message — and
`src/app/dashboard/error.tsx` (Phase 6) was built specifically to
display `error.message` nicely instead of Next's raw overlay. In `npm
run dev` this works. In the actual production build (`npm run build` +
`npm run start` — i.e. what's actually running day to day), Next.js
redacts thrown Server Action/Server Component error messages on the
client by design, replacing them with a generic "Minified React error
#441" and a digest. Confirmed directly: triggered a real `QuotaError`
("Your Free plan allows 3 manual crawls per calendar month...") and
captured the real message in the server's own log, while the browser
showed only the digest.

**Fix**: convert the affected forms from plain `<form action={fn}>` +
throw to the `useActionState` pattern — actions return
`{ error: string } | { success: true, ... }` instead of throwing for
*expected* error cases (validation, quota, SSRF), and a small client
wrapper around each form displays `state.error` inline. This touches:
`addWebsite`, `triggerCrawl`, `setWebsiteSchedule`, `verifyWebsite`,
`generateReport`, `cancelCrawl`, `markNotificationRead`, and billing's
`changePlan`/`openBillingPortal`. Not done yet — found while visually
verifying the report-polish pass, out of that pass's scope, flagged
here rather than silently fixed or silently ignored.

## Fixed in this session (2026-10-22, on a real Windows dev machine)

- **`scripts/dev-stop.ps1` itself had the same orphan-process bug class
  it was written to prevent**, on the app server this time: it matched
  the `npm run start` wrapper's command line but not the actual `next
  start` child process's command line, so a stale pre-Phase-6 build kept
  silently serving on port 3000 and 404ing the new `/dashboard/billing`
  route. Fixed to also kill by current port ownership (3000/3001/4100),
  not just command-line pattern match.

- **Crawler never ran on Windows.** The Phase 3 adapter hardcoded the path
  to the Linux ELF binary built in the Linux sandbox; on Windows the
  subprocess never started, producing a confusing `ENOENT` on the
  *output* file rather than an obvious wrong-binary error. Fixed by
  vendoring the official Windows release binary alongside the Linux one
  and making `crawler-adapter.ts` pick by `process.platform`.
- **Tenant isolation gap**, flagged since Phase 4/5 and now actually
  closed: every dashboard server action (`triggerCrawl`, `cancelCrawl`,
  `setWebsiteSchedule`, `verifyWebsite`, `generateReport`,
  `markNotificationRead`) and the report-download route trusted a
  websiteId/reportId/notificationId straight out of form data or the URL
  with zero check that the caller's organization actually owned it. Any
  authenticated user from any org could view, cancel, reschedule, or
  download another org's data by guessing/reusing a UUID. Fixed with a
  shared guard (`src/lib/tenant.ts`) applied at every one of those call
  sites; "not found" is returned uniformly for "doesn't exist" vs.
  "belongs to another org" so the error can't be used to enumerate other
  orgs' ids.
- **SSRF-blocked crawls surfaced as a confusing "critical finding"**
  instead of failing fast with a clear message when the site is added.
  `addWebsite` now runs the same SSRF pre-flight immediately and refuses
  with a plain-English error before ever creating the website row.
- **npm audit: 18 → 9 vulnerabilities, 1 critical → 0 critical.**
  Removed `@better-auth/cli` as a standing dependency (it was only ever
  used once, interactively, to generate `auth-schema.ts` — its own
  vendored `better-auth`/`drizzle-orm`/`chevrotain→lodash` dependency
  chain accounted for 4 of the 6 original vulnerability groups,
  including both "no fix available" criticals/highs, none of which were
  ever reachable at runtime). Bumped `nodemailer` to `^10.2.0` (the one
  real *runtime* dependency in the list) and re-verified the SMTP
  no-op/real-send tests both still pass.
- A real process-management footgun: killing the wrapping PowerShell
  window left the actual worker `node`/`tsx` process orphaned and
  running stale code, racing a freshly started one. Added
  `seo-platform/scripts/dev-stop.ps1` / `dev-start.ps1` so this doesn't
  bite again.

## Deliberately NOT fixed, with reasoning

- **`braces` (high, via eslint-config-next's own transitive chain) and
  `esbuild` (moderate, via drizzle-kit's legacy `@esbuild-kit` loader)**
  — both dev-tooling-only, never reachable at runtime (esbuild's issue is
  about its own dev server; braces' is a ReDoS on glob patterns run only
  against our own source tree). `npm audit fix --force`'s proposed
  "fixes" are actual *downgrades* (eslint-config-next 16.4.2 → 14.2.35,
  drizzle-kit 0.31.11 → 0.18.1) that would be materially worse than the
  vulnerabilities themselves. A `drizzle-kit@1.0.0-rc` exists but wasn't
  adopted — jumping to a release candidate for our actual migration
  tooling, just to silence a dev-server-only warning, is a bad trade.
  Revisit when either package ships a stable fix that isn't a downgrade.
- **A pre-existing flaky test** (`reports/generate.test.ts`, "expected 5
  to be greater than 5" on `findings.length`) surfaced while re-running
  the full suite after the tenant-isolation fix. Confirmed unrelated to
  that fix (passes 5/5 in isolation every time; only flakes under full-
  suite resource contention) and unrelated to any other change in this
  session. Not chased down — flagging the exact assertion
  (`src/lib/reports/generate.test.ts:83`) for whoever picks this up next.

## Carried forward from earlier phases (still open)

- **JS-rendering (`--browser` mode) has never been exercised for real**
  — no Chromium-family browser was available in the Linux build sandbox.
  Needs a real run wherever Chromium is available (the Docker image
  bundles no browser yet either).
- **The worker's Docker image has never actually been built**, only
  reasoned through statically (confirmed in this session that it's
  correctly scoped to the Linux vendor binary only, via an explicit
  `CRAWLER_BIN_PATH`, so today's Windows-binary addition doesn't affect
  it — but "never built" is still true and should be verified before
  relying on it for deployment).
- **Vendored crawler binaries are committed directly to git**
  (~39MB Linux + ~24MB Windows) rather than fetched/built at image-build
  time. Acceptable for now, not great repo hygiene long-term.
- **No single test proves the full chain** "scheduled crawl fires → new
  findings found → notification row written" end-to-end — each link is
  proven individually (scheduling, diffing, notifying), not as one
  combined test.
- **Deleting a website with a crawl job still queued/retrying for it**
  leaves an orphaned pg-boss job that fails cleanly on an FK violation —
  a sane terminal state, not stuck, but not an elegantly handled case.

## Explicitly out of scope so far (next phases per IMPLEMENTATION_PLAN.md)

- Stripe billing / usage quotas / plan enforcement (Phase 6)
- Full security review pass, dependency scanning in CI, Docker hardening
  (Phase 7)
- Deployment docs, backup/restore procedures (Phase 8)
- The "premium UI/UX" design-system pass from the original project brief
  (Part 3 of the additional directive) — see the design-updates list
  given alongside this file for what that would involve; none of it has
  been started. The app is currently a plain, functional, unstyled-beyond-defaults
  dark UI.
