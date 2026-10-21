# Architecture Decision Record — AI SEO Platform

Status: **Decided** (Phase 1 complete). Full research backing this decision is in
`REVERSE_ENGINEERING.md` and `FEATURE_COMPARISON.md` in this same directory;
the full reasoning trail is in `architecture_recommendation.md`. This file is
the condensed, durable record.

## Decision

Build the application foundation **fresh**, not on top of any of the six
candidate repos. Reuse three specific components via thin adapters.

**Stack:** Next.js (App Router) + TypeScript · PostgreSQL + Drizzle ORM ·
Better Auth (organizations + Stripe plugin) for accounts/billing · **pg-boss**
(a Postgres-native job queue — chosen over Redis-backed BullMQ specifically
to avoid an extra infrastructure dependency on a self-hosted single-server
target; jobs persist in the same Postgres instance and survive restarts)
for crawl/report/AI jobs · Ollama as the default local AI provider via an
OpenAI-compatible endpoint.

## Why no candidate repo qualifies as the foundation

The platform needs four things simultaneously: (1) a real JS-rendering
crawler, (2) technical-SEO analysis/reporting, (3) local-Ollama AI with no
mandatory paid API, (4) real multi-tenant SaaS accounts/billing. Across the
six repos evaluated, **no single repo clears both "real multi-tenant SaaS
shape" and "real local-AI support"**:

| Repo | Multi-tenant orgs | Local Ollama AI | Disqualifying issue |
|---|---|---|---|
| every-app/open-seo | ✅ (only one with real org schema) | ❌ none found | Mandatory paid DataForSEO API + Cloudflare-proprietary runtime (Durable Objects/Workflows) + third-party Autumn billing |
| IamRamgarhia/All-In-One-Free-SEO-Tool | ❌ single-install, one-agency model | ✅ | No `organizationId` anywhere in schema; retrofitting real tenancy is a bigger, riskier job than building it right from day one |
| janreges/siteone-crawler | N/A (CLI) | ✅ | Not an app at all — no DB, no UI, no accounts. Excellent as a *component*. |
| PhialsBasement/LibreCrawl | ⚠️ claimed, but broken | ❌ | Confirmed bug: every logged-in user is granted `tier='admin'`; zero CI |
| StJudeWasHere/seonaut | ❌ | ❌ | No AI anywhere; least recently active of the six |
| crawlseo/crawlseo | ❌ | ❌ (MCP server ≠ built-in AI) | No JS rendering; AI is "expose MCP to an external agent," not generate recommendations itself |

Full per-repo evidence (license, stack, test coverage, CI, verified vs.
false README claims) is in `REVERSE_ENGINEERING.md`.

## What we reuse, and how

1. **Crawler engine:** `janreges/siteone-crawler` (Rust binary, MIT), invoked
   as a subprocess per crawl job with `--output=json`. It already does
   static HTTP crawling *and* real Chromium/CDP JS rendering *and* already
   speaks Ollama via an OpenAI-compatible endpoint. Our job queue owns
   concurrency, tenancy, and resource limits around it; the binary itself
   stays stateless and tenant-unaware.
2. **Multi-tenant auth/billing:** the `better-auth` npm library directly
   (not the open-seo repo it's sourced from) with its `organization` plugin
   for orgs/members/invitations and its official Stripe plugin for
   subscriptions, run in test mode until explicitly approved for live
   payments.
3. **SEO rule corpus:** check *concepts and thresholds* (title-length
   ranges, duplicate-meta detection, severity taxonomy) ported from
   IamRamgarhia's `tech-audit-rules.ts`/`audit-score.ts` and seonaut's
   `internal/issues` taxonomy — both MIT, concepts only, no application
   code pulled in wholesale.
4. **Network safety pattern:** crawlseo's `outbound-hosts.json`
   egress-allowlist pattern, adapted for our own crawler/API egress rules
   (SSRF/private-network/localhost protection).

## What we explicitly avoid

- Forking **open-seo** — DataForSEO + Cloudflare + Autumn triple vendor
  lock-in contradicts "self-hosted, no mandatory paid API."
- Copying **LibreCrawl**'s auth/session code — confirmed privilege-escalation
  bug (`tier='admin'` for every user).
- Retrofitting multi-tenancy onto **all-in-one-free-seo-tool** — its data
  model assumes one tenant per install; the ~90-tool surface would also need
  full audit for quality we didn't build.

## License compliance

All six repos are MIT-licensed. Where we port rule *concepts* (item 3 above),
we are reusing ideas/thresholds, not copying substantial original code
verbatim; where we do copy small verbatim snippets (e.g. a specific regex or
threshold constant), MIT requires only that we retain the copyright notice —
tracked in `THIRD_PARTY_NOTICES.md` (to be created when the first such
snippet is actually ported in Phase 3). The `siteone-crawler` binary is used
as an unmodified external subprocess dependency (MIT), not vendored code, so
its license notice is carried in our deployment docs/Docker image, not
inline in our source.

## Deployment shape (unchanged by this decision)

Docker Compose: `app` (Next.js), `worker` (pg-boss job consumer, same
codebase different entrypoint), `postgres`, `ollama` (optional, local AI),
and the `siteone-crawler` binary baked into the `worker` image. No Redis or
other extra infra — pg-boss uses the same Postgres instance. Runs
identically in Windows dev (Docker Desktop) and the Linux production
target.
