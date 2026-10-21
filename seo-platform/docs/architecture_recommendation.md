# Architecture Recommendation — Phase 1 Decision

**Decision: build the Phase 2 application foundation fresh, in TypeScript/Node.js (Next.js App
Router + PostgreSQL + a real background-job queue). Do not fork or build on top of any of the six
candidate repos as the base application. Reuse three specific components from the candidates via
thin adapters, not via repo merge.**

This is deliberate and decisive, not a hedge — the reasoning is below, followed by exactly what to
take from where.

---

## Why none of the six is the foundation

The project needs four things at once: (1) a real, self-hosted crawler with JS-rendering
capability, (2) a technical-SEO analysis/reporting layer, (3) AI recommendations running against a
**local Ollama** model with no mandatory paid third-party API, and (4) real multi-tenant SaaS
accounts and billing. No single candidate has all four without a disqualifying compromise:

- **every-app/open-seo** is the most popular, most tested, and the *only* repo with a genuine
  multi-org + billing-state schema — on paper the closest fit for requirement (4). But it fails
  (3) completely (zero Ollama/local-model support anywhere in source) and its core value for
  keyword research, rank tracking, and backlinks is a thin layer over a **mandatory paid
  DataForSEO subscription** — directly contradicting "self-hosted, open source, you own your
  data." Its background-job and crawl-state machinery is also written directly against
  Cloudflare Durable Objects and Cloudflare Workflows, which are not portable primitives —
  reusing its crawler would mean reimplementing its job orchestration on different infrastructure
  anyway, at which point it is no longer "reuse." Forking this repo would mean inheriting a
  dependency on two separate proprietary vendors (DataForSEO for data, Autumn for billing) plus a
  non-portable runtime, in exchange for a billing schema we can get more cheaply by adopting the
  *library* it uses (Better Auth) directly, without the rest of the repo.

- **IamRamgarhia/All-In-One-Free-SEO-Tool** is the best-aligned on stack (Next.js/TS/Drizzle —
  very close to what we'd choose anyway), has real Ollama support, a real Playwright crawler, and
  by far the best test discipline of any web-app candidate. It is the strongest *single-repo*
  candidate. It is disqualified as the foundation for one structural reason: it has **no
  multi-organization model at all** — it is architected as "one install = one agency, with team
  members and assigned clients," which is a fundamentally different shape than "many independent
  paying customer organizations, each isolated, each billed separately." Retrofitting true
  tenant isolation onto an app whose entire data model (`clients`, `clientMembers`, scoped
  queries keyed off a single `users` table with no `organizationId` anywhere) assumes one tenant
  per install is a bigger, riskier job than building the right shape from day one — and we would
  still inherit ~90+ feature-surface "tools" pages of unknown individual quality that we did not
  ask for and would be on the hook for auditing. A ~5-month-old, small-team project is also a
  thinner foundation to bet a whole platform's future maintainability on than writing the
  10-15% of it we actually need, correctly shaped, ourselves.

- **janreges/siteone-crawler** is excellent and is **not disqualified** — it is simply not an
  application foundation at all (no DB, no accounts, no web UI, it's a CLI). It is the single best
  *component* in this entire set (see below).

- **PhialsBasement/LibreCrawl**, **StJudeWasHere/seonaut**, and **crawlseo/crawlseo** are all
  reasonable, honest, MIT-licensed tools, but each is missing a requirement outright: LibreCrawl
  has no AI, no CI, and a confirmed authorization bug (every logged-in user becomes
  `tier='admin'`); seonaut has no AI and the least recent development activity of the six;
  crawlseo has no built-in AI *recommendations* (only MCP data exposure) and no JS rendering. None
  of the three has a multi-tenant org model either. They are good *reference material* (seonaut's
  clean layered Go architecture and issue taxonomy; crawlseo's outbound-hosts egress-allowlist
  pattern), not foundations.

**The pattern across all six:** the repos split cleanly into "has real multi-tenant SaaS shape"
(exactly one: open-seo, which fails on AI and vendor lock-in) versus "has real local-AI/Ollama
support" (exactly two: all-in-one-free-seo-tool and siteone-crawler, neither of which has
multi-tenancy). There is no repo that clears both bars, and the one that comes closest to a full
product (open-seo) does so by outsourcing the two hardest parts (data acquisition, billing) to
paid third parties we were explicitly asked to avoid depending on. Building fresh, with full
control over the tenancy model from the first migration and Ollama as a first-class citizen from
the first AI call, is less risky than unwinding any of these compromises after the fact.

---

## What to actually build on (Phase 2 scaffolding guidance)

**Foundation:** Next.js (App Router) + TypeScript, PostgreSQL + Drizzle ORM, a real job queue
(e.g. BullMQ/Postgres-backed queue — not an in-process scheduler) for crawl and report jobs. This
mirrors the stack that scored best across the comparison table (TypeScript + Postgres + Drizzle
is exactly what `crawlseo` and `open-seo`'s Postgres mode use, and is one ORM-swap away from
`all-in-one-free-seo-tool`'s Drizzle/SQLite setup) while avoiding SQLite's single-writer ceiling
for a real multi-tenant deployment and avoiding Cloudflare-specific primitives entirely so the app
runs on any Docker host or VPS.

### Components to reuse or port via an adapter (not a repo merge)

1. **Crawler engine → `janreges/siteone-crawler` (Rust binary), invoked as a subprocess.**
   This is the single highest-value reuse in the whole set: a 3-year-proven, actively released,
   genuinely fast, dependency-free binary that already does static HTTP crawling *and* real
   Chromium-based JS rendering *and* already speaks to Ollama via an OpenAI-compatible endpoint —
   all the hard, slow-to-get-right parts of a crawler. Wrap it with a thin adapter: our job queue
   shells out to the binary per crawl with `--output=json`, parses its JSON report into our own
   `audits`/`audit_issues` tables, and manages concurrency/lifecycle/resource limits at the job
   level (the binary has no concept of our tenants or jobs, which is fine — that's our layer's
   job). This avoids writing and maintaining our own crawler/renderer from scratch, which is the
   single most time-consuming and bug-prone part of any SEO tool, while keeping our own app
   unencumbered by Rust in the request path (it's one subprocess call per crawl job).

2. **Multi-tenant auth + org model → adopt the `better-auth` library directly** (the same OSS
   library `every-app/open-seo` depends on), not the open-seo repo. Better Auth is a standalone
   npm package that works in any Node/Next.js app, ships its own `organization`/`member`/
   `invitation` plugin, and has an official Stripe plugin for subscriptions — giving us the real
   multi-org + billing shape open-seo has, without inheriting its Cloudflare runtime, its
   DataForSEO dependency, or its Autumn billing dependency. Pair it directly with **Stripe** (not
   Autumn) for billing, since Stripe is the more portable, directly-integrable choice and avoids
   a second proprietary billing vendor.

3. **SEO rule corpus → port the *concepts*, not the code, from `IamRamgarhia/all-in-one-free-seo-tool`'s
   `tech-audit-rules.ts`/`issue-explainers.ts`/`audit-score.ts` and from `seonaut`'s
   `internal/issues/{errors,multipage,page}` taxonomy.** Both give a good, already-thought-through
   starting checklist (critical/high/low severity; page-level vs. site-wide issues; the specific
   set of technical SEO checks worth running) to seed our own rule engine against the JSON the
   siteone-crawler adapter produces. Because both are MIT, direct reuse of specific check
   constants/thresholds (e.g. title-length ranges, duplicate-meta detection logic) is legally fine
   where it's useful — but the *application* code around them (their DB schema, their routing,
   their auth) should not be pulled in wholesale.

4. **Egress/SSRF allowlist pattern → adopt `crawlseo`'s `outbound-hosts.json` + CI-enforced
   egress-allowlist pattern** for our own crawler's network policy (and for any outbound calls our
   backend makes to Google Search Console, PageSpeed Insights, etc.). It's the clearest, most
   directly copyable security pattern found in this research, independent of the rest of that
   repo.

### What to avoid entirely, and why

- **every-app/open-seo as a foundation** — mandatory paid DataForSEO dependency for most
  user-facing value, Cloudflare-proprietary runtime coupling (Durable Objects, Workflows, D1/KV)
  that makes "self-hosted anywhere" aspirational rather than real, third-party Autumn billing
  dependency, and zero Ollama support. Take only the *idea* of its Better-Auth-based org schema
  (via the library itself, as above) — not its code, not its infra pattern.
- **PhialsBasement/LibreCrawl, as a foundation or even for direct code reuse of its auth/session
  layer** — the confirmed `tier='admin'`-for-everyone bug means its authorization code must not be
  copied as-is under any circumstance; combined with zero CI and the thinnest test suite of the
  six, this is the highest-maintenance-risk repo in the set.
- **Forking `all-in-one-free-seo-tool` and bolting multi-tenancy onto it after the fact** — tempting
  because it's the best-aligned single repo, but its single-tenant-per-install data model and
  ~90-tool feature surface make "add real multi-org isolation" a bigger, riskier retrofit than
  building the 10-15% of its functionality we need (the crawler adapter pattern, the rule corpus,
  the Ollama-via-OpenAI-compatible-endpoint pattern) on a foundation shaped correctly from the
  start.
- **StJudeWasHere/seonaut and crawlseo/crawlseo as foundations** — both are good, honest, well-built
  tools with nothing disqualifying in their own right, but neither clears the AI-recommendations
  bar, and neither has multi-tenancy; there's nothing in their application layer (as opposed to
  specific patterns, credited above) worth inheriting over building fresh on the stack chosen
  above.

---

## Net effect for Phase 2 scaffolding

Build: Next.js/TS app, Postgres+Drizzle, Better Auth (orgs + Stripe plugin) for accounts/billing,
a real job queue for crawl/report/AI jobs, and an Ollama client using the same
OpenAI-compatible-endpoint pattern already proven in two of the six candidates. Integrate: the
`siteone-crawler` binary as a subprocess-based crawler adapter, with a rule engine seeded from
IamRamgarhia's and seonaut's check taxonomies, and crawlseo's egress-allowlist pattern for network
safety. This gets a working, honestly-self-hosted, local-AI-capable, real-multi-tenant foundation
in place for Phase 2 without inheriting any of the six repos' disqualifying compromises.
