# Feature Comparison: Six Candidate Repos

Compiled 2026-10-21. Star/fork/issue/created-date figures are live GitHub metadata; everything
else is verified against the cloned source tree (see `REVERSE_ENGINEERING.md` for the detailed,
per-repo evidence behind every cell below). "Last commit" is the actual `git log -1` date of the
clone, which in one case (`seonaut`) differs meaningfully from GitHub's `updated_at` field — the
commit date is used here as the more reliable "is it being worked on" signal.

| | **IamRamgarhia/All-In-One-Free-SEO-Tool** | **janreges/siteone-crawler** | **PhialsBasement/LibreCrawl** | **StJudeWasHere/seonaut** | **crawlseo/crawlseo** | **every-app/open-seo** |
|---|---|---|---|---|---|---|
| **Stack** | TypeScript, Next.js 16 / React 19, Drizzle ORM | Rust (native binary) | Python, Flask | Go, Gorilla | TypeScript, Next.js, Prisma | TypeScript, Cloudflare Workers (Vite/Wrangler) |
| **License (SPDX)** | MIT | MIT | MIT | MIT | MIT | MIT |
| **Repo created** | 2026-05-02 | 2023-10-04 | 2025-09-27 | 2022-03-02 | 2026-04-06 | 2026-02-27 |
| **Stars / forks / open issues** | 73 / 24 / 0 | 965 / 90 / 17 | 1,070 / 215 / 32 | 810 / 139 / 12 | 640 / 94 / 3 | 24,331 / 3,281 / 210 |
| **Last commit (local clone)** | 2026-10-19 | 2026-09-27 | 2026-09-29 | 2026-06-14 | 2026-10-20 | 2026-10-19 |
| **Has automated tests** | Yes — 97 unit test files + Playwright e2e + PHP tests | Yes — fixture-based tests (6 files) | Weak — ~10 test functions, **no CI at all** | Yes — 39 Go test files | Yes — 73 unit test files + e2e | Yes — 242 test files + e2e (largest suite) |
| **Has CI** | Yes | Yes (3 workflows incl. release) | **No** | Yes | Yes | Yes (4 workflows) |
| **Database** | SQLite (Drizzle ORM) | None (CLI, stateless) | SQLite (hand-rolled, no ORM) | MySQL (required) | PostgreSQL (Prisma) | D1 (SQLite-compat) or Postgres |
| **Has auth** | Yes — custom scrypt + sessions, opt-in | N/A (local tool) | Yes — bcrypt, but see bug below | Yes — simple email/password | Yes — NextAuth v5 | Yes — Better Auth |
| **Multi-tenant (real orgs)** | No — single install, team roles per one agency | N/A | Claimed ("multi-tenancy") but is really just concurrent isolated sessions; **every logged-in user is granted `tier='admin'` — an authorization bug** | No — one user owns N sites, no teams | No — single-user tool, no org/workspace model found | **Yes — real `organization`/`member`/`invitation` schema, the only one of the six** |
| **Billing/subscription support** | None | N/A | None | None | None | Yes — `billing.schema.ts` tracks paying status per org, via third-party "Autumn" (not direct Stripe) |
| **Has dashboard/web UI** | Yes — full Next.js app, ~90+ tool pages | No — CLI + static HTML report (separate GUI project exists, not reviewed) | Yes — Flask web UI | Yes — server-rendered + ECharts | Yes — Next.js dashboard | Yes — full web dashboard |
| **Crawler type** | JS-rendering (Playwright, pooled browser) | Dual: static HTTP by default, **real Chromium via CDP** with `--browser` | JS-rendering (Playwright) | Static HTML only (no headless-browser dep; no false claim) | Static HTML only (Playwright used only for the project's own e2e tests, not crawling) | Static HTML for the site-audit workflow; sophisticated self-written durable/chunked crawler, but no headless-browser dep found |
| **AI recommendations built in** | **Yes** — multi-provider dispatcher incl. Anthropic/Gemini/OpenAI-compatible | **Yes** — opt-in LLM layer for SEO rewrites, `llms.txt`, policy checks | **No** — zero AI code anywhere | **No** — zero AI code anywhere | **No** — only exposes an MCP server for an *external* agent; README's "AI agent ready ✅" implies more than this | Uses Vercel AI SDK with cloud providers for AI-visibility features |
| **Local Ollama support (verified)** | **Yes** — documented, working, via OpenAI-compatible endpoint (`localhost:11434`) | **Yes** — explicitly listed OpenAI-compatible target, real `src/ai/provider.rs` | No | No | No | **No** — zero `ollama` references found anywhere in source or docs |
| **Core SEO data source** | Self-contained (own crawler + own checks); keyword-volume honestly flagged as "directional estimate," no paid API required | Self-contained (own crawler + own checks) | Self-contained (own crawler + own checks) | Self-contained (own crawler + own checks) | Self-contained crawler/CWV/GSC; keyword/backlink data is BYOK DataForSEO (optional, honestly disclosed) | Self-contained site-audit crawler; **keyword/rank/backlink data hard-requires a paid DataForSEO API key** |
| **Self-hostable without a specific cloud vendor** | Yes — Docker, or plain Node, runs anywhere | Yes — single static binary, runs anywhere | Yes — Docker or plain Python, runs anywhere | Yes — Docker or Go binary + MySQL, runs anywhere | Yes — Docker, conventional Node/Postgres | Partial — Docker self-host path exists but is explicitly the less-supported path; architecture leans on Cloudflare Durable Objects/Workflows/D1/KV |
| **Maintenance risk** | **Medium** — very active, well-tested, but young (~5 months), huge feature surface (~90+ tools) increases audit burden, single/small maintainer | **Low** — 3-year track record, steady releases, oldest and most battle-tested of the six | **High** — no CI, thin tests, highest open-issue ratio, confirmed authorization bug, single maintainer handle | **Low-Medium** — 4 years old, clean code, good tests, but lowest recent commit activity of the six (4+ months stale on `main` as of this research) | **Low-Medium** — young (~6.5 months) but very active, clean incremental migration history, low open-issue count, good CI | **Medium** — by far the most active/popular/tested, but young (~8 months), and architecturally the highest-risk to depend on for *this* project specifically because of the DataForSEO + Cloudflare + Autumn triple vendor lock-in |

## Notes on cells that need interpretation, not just a checkbox

- **"Multi-tenant" for LibreCrawl** is marked with a caveat rather than a flat "Yes/No" because the
  README's claim and the code's actual behavior diverge: sessions are isolated, but the
  authorization model collapses every authenticated user to `tier='admin'` in `main.py`, so
  "isolated" does not mean "access-controlled."
- **"AI recommendations built in" for crawlseo** is "No" rather than a half-credit "Yes" because
  exposing an MCP server for an external agent to call is a materially different capability from
  generating recommendations itself — the project's requirement is for the *platform* to produce
  AI recommendations (via local Ollama), which crawlseo's MCP server does not do on its own.
- **"Self-hostable without a specific cloud vendor" for open-seo** is "Partial" because a Docker
  self-host path is documented and exists, but the maintainers themselves steer users toward
  Cloudflare, and core background-job orchestration (Workflows) and crawl-state storage (Durable
  Objects) are Cloudflare-proprietary APIs imported directly in source — a non-Cloudflare
  deployment is not simply "the same code, different host."
