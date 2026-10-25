# Test Results (Phase 7)

Real output from real commands, run in this sandbox against a real
local Postgres (no Docker daemon available here — see
`SECURITY_REVIEW.md` §4 for why the Docker changes in this phase are
unverified by an actual `docker compose build`). Nothing below is
estimated or inferred.

## Summary

| Command | Result |
|---|---|
| `npx vitest run` | **191 passed, 2 skipped (193 total), 30 files, exit 0** |
| `npx tsc --noEmit` | clean, exit 0 |
| `npx eslint .` | **0 errors**, 4 pre-existing warnings (unrelated files, unchanged this phase) |
| `npm run build` | exit 0, 13 routes (11 from before + 2 new: `/forgot-password`, `/reset-password`) |

Baseline before this phase's changes (re-confirmed, not assumed):
**173 passed, 2 skipped, exit 0** — matches Phase 6's own reported
number. 18 new tests were added this phase (173 + 18 = 191); nothing
existing was deleted, skipped, or weakened to make this number work.

Full raw `vitest` summary line from the final run:

```
 Test Files  30 passed (30)
      Tests  191 passed | 2 skipped (193)
   Start at  01:21:33
   Duration  95.54s (tests 91%, import 8%)
```

## The 2 skipped tests — why, honestly

Both are in `src/lib/ai/recommendation-engine.test.ts`, guarded by
`(ollamaAvailable ? it : it.skip)`. Confirmed directly in this sandbox:
`curl http://localhost:11434/api/tags` → connection refused (exit 7, no
Ollama process running here). These tests exercise a real round trip
to a real local Ollama model when one is reachable; they are not
disabled by choice, they genuinely cannot run without Ollama installed
and a model pulled. This mirrors exactly what Phase 4/5/6 already
documented about this same pair of tests — not a new or hidden gap.

## What each test category actually proves (honest coverage map)

| Area | File(s) | What's proven | What's NOT proven by these tests |
|---|---|---|---|
| Tenant isolation | `dashboard/cross-org-isolation.test.ts`, `lib/auth/require-org-access.test.ts` | A member of org A gets 404/403 trying to act on org B's website/crawl-job/report/notification by id, for every gated action; positive controls prove the legitimate org still works. | Does not cover every possible future call site — a new action must remember to use `require-org-access.ts` itself. |
| Role enforcement | `dashboard/role-enforcement.test.ts` | A plain `member` is denied `deleteWebsite` and billing actions (owner/admin-only); Better Auth's own org-plugin permission statements deny invite/role-change for members. | — |
| Billing/quota | `lib/billing/quota.test.ts`, `dashboard/billing-quota.integration.test.ts`, `lib/billing/mock-provider.test.ts`, `lib/billing/stripe-provider.test.ts` | Plan limits (websites, monthly manual crawls, scheduling, AI gate) are enforced through the real server actions, not just the helper functions; Stripe webhook signature verification is real (offline, against the real Stripe SDK); the live-key guard (`sk_test_` only) is real. | No test here ever talks to the real Stripe API over the network (no live/test Stripe account in this sandbox) — only offline signature/plumbing verification. |
| **New: auth rate limiting** | `app/api/auth/rate-limit.test.ts` | The real `/api/auth/sign-in/email` route handler returns 429 after Better Auth's built-in budget (3/10s) is used by one client IP; a different IP has an independent budget; **demonstrated the fix is load-bearing** by temporarily disabling `rateLimit.enabled` and watching the same test fail, then re-enabling it. | Does not test behind a real reverse proxy / real `X-Forwarded-For` chain — see `SECURITY_REVIEW.md`'s configuration caveat. |
| **New: manual-crawl burst limiting** | `dashboard/manual-crawl-rate-limit.test.ts` | The real `triggerCrawl` server action rejects the 11th rapid trigger within 60s even on a plan with an *unlimited* monthly quota (Starter), proving the new burst limiter — not the existing monthly quota — is what blocks it; a different user has an independent budget. | Single-process only (in-memory) — would not coordinate a limit across multiple app instances (documented as an accepted gap for this project's single-instance target). |
| **New: password reset** | `lib/auth-password-reset.test.ts` | A real token is created by `requestPasswordReset`, consuming it via `resetPassword` actually changes the stored credential (old password then fails, new one works), the token is single-use (reuse rejected), and an unknown email gets the identical response with no verification row created (no enumeration oracle). | Does not test the actual emailed link/UI pages end-to-end in a browser — the two new pages (`forgot-password`, `reset-password`) are covered by `tsc`/`build`/manual code review, not a browser-driven test. |
| **New: HTML report XSS escaping** | `lib/reports/html.test.ts` | A `<script>alert(1)</script>` payload placed in every untrusted field (finding title/description/category/url, AI recommendation title/body, website URL, org name, history sample) never appears unescaped in the rendered HTML; **proven to be a real, load-bearing test** by temporarily removing one `escapeHtml()` call and watching it fail, then restoring it. | Does not render the HTML in an actual browser DOM to confirm no script executes — asserts on the string output, which is the correct level for this kind of proof (the escaped entities cannot execute regardless of renderer). |
| **New: CSV formula injection** | `lib/reports/csv.test.ts` | Fields starting with `=`,`+`,`-`,`@` are prefixed with a neutralizing quote before CSV-quoting (both alone and combined with comma/quote escaping); ordinary titles are left untouched. | Does not open the CSV in an actual copy of Excel/Sheets to confirm the mitigation's real-world effect — relies on the documented OWASP mitigation being correct, which it is (a leading `'` is the standard, widely-deployed fix). |
| Crawling / SSRF safety | `lib/crawl-safety.test.ts`, `lib/crawler-adapter.test.ts` | Real subprocess crawls against a real fixture server; SSRF protections (private/loopback/reserved ranges, DNS-rebinding pinning, redirect re-validation, response size caps) exercised for real, not mocked. Untouched this phase. | — |
| Reports (PDF/HTML/CSV/JSON) | `lib/reports/*.test.ts` | Health-score math, category-score math, and now escaping/injection-safety are all checked against real computed values. | PDF visual rendering is not pixel-tested (as in prior phases — a signature/structure check only). |
| Jobs / scheduling / retries | `lib/jobs/*.test.ts`, `worker-restart-recovery.test.ts` | Real pg-boss retry/backoff, real worker-restart recovery (a worker process is actually killed and a new one resumes the job), real cron-based scheduling. Untouched this phase. | — |
| AI recommendations | `lib/ai/recommendation-engine.test.ts` | Grounding (finding ids are never parsed from model output) and the no-fabricated-metrics guard are proven with real Ollama round trips *when Ollama is reachable* (2 tests skipped here, see above). | — |

## Build and lint detail

`npm run build` output (trimmed to the parts that matter — two
pre-existing Next.js tracing warnings about dynamic filesystem access
in `src/lib/reports/generate.ts`, unrelated to this phase and not
errors):

```
Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /api/auth/[...all]
├ ƒ /api/health
├ ƒ /api/reports/[id]
├ ƒ /api/webhooks/stripe
├ ƒ /dashboard
├ ƒ /dashboard/audit-log
├ ƒ /dashboard/billing
├ ƒ /dashboard/websites/[id]
├ ○ /forgot-password
├ ○ /login
├ ○ /register
└ ○ /reset-password
```

`npx eslint .` output in full:

```
/home/user/Belmont/seo-platform/app/src/lib/ai/recommendation-engine.test.ts
  175:18  warning  '_messages' is defined but never used  @typescript-eslint/no-unused-vars
  175:44  warning  '_opts' is defined but never used      @typescript-eslint/no-unused-vars

/home/user/Belmont/seo-platform/app/src/lib/billing/mock-provider.ts
  47:28  warning  '_rawBody' is defined but never used    @typescript-eslint/no-unused-vars
  47:55  warning  '_signature' is defined but never used  @typescript-eslint/no-unused-vars

✖ 4 problems (0 errors, 4 warnings)
```

Confirmed pre-existing (not introduced this phase) via `git diff` —
this phase never touched either file.

## What was NOT run in this phase (honest scope boundary)

- No real Docker build/run (`docker compose build`/`up`) — no usable
  Docker daemon in this sandbox (`docker info` fails; attempting
  `dockerd` directly fails on `ulimit: error setting limit (Operation
  not permitted)`, consistent with a container-in-container
  restriction). `docker compose config` (pure YAML parsing) does
  succeed and confirms the compose file is syntactically valid with the
  new resource-limit blocks correctly resolved.
- No real Stripe API network calls (no live/test Stripe account
  available) — same gap already documented in Phase 6.
- No real end-to-end browser test of the new `/forgot-password`/
  `/reset-password` pages (no browser automation tool exercised in this
  phase) — covered instead by `tsc`, `build`, and the server-side flow
  test (`lib/auth-password-reset.test.ts`), which is what actually
  matters securitywise (token validity/expiry/single-use enforcement
  happens entirely server-side).
