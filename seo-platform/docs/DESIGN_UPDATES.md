# Design Updates — Not Yet Started

Status: **planning list only, nothing implemented**. The app today (all
screenshots in this session) is a plain dark page — system font, no color
tokens, no spacing/elevation system, no motion — functional but not the
"premium B2B SaaS" look the original project brief calls for (see the
master prompt's "Additional Directive" Part 3 and Part 5). This file is
the punch list for that pass, broken into what's cheap/foundational vs.
what's a bigger lift, so it can be picked up in vertical slices rather
than one giant redesign.

## Why this hasn't happened yet

Every phase so far (1–5) deliberately prioritized a working, verified,
secure pipeline over visual polish — per the project's own instruction to
get one stable end-to-end workflow (crawl → findings → AI → report)
before investing in animation/design. That milestone is now solid. This
is a reasonable next investment, but it's a genuinely separate, sizable
piece of work — not a quick pass.

## Foundational (do first — everything else builds on this)

1. **Design tokens.** Right now colors/spacing/radii are ad hoc Tailwind
   utility classes with no shared scale. Needs: a real color system (not
   just "black background, white text") with light AND dark themes, a
   type scale, spacing scale, border-radius scale, and elevation/shadow
   tokens, defined once and consumed everywhere.
2. **Typography.** Currently default system font stack with no
   hierarchy beyond browser defaults. Needs a deliberate type scale
   (display/heading/body/caption) and a real font choice (or a refined
   system-font stack with proper weight/tracking).
3. **Component primitives.** Buttons, form inputs, cards, badges
   (severity pills already exist informally — `critical`/`high`/etc. —
   but aren't a real design-system component), tables, and empty/loading/
   error states are all one-off per page right now. Needs a small shared
   component layer so every new page doesn't reinvent these.

## Per-screen, once tokens/components exist

4. **Landing/marketing page** — doesn't exist yet at all; `/` just
   redirects into the app shell. The original brief calls for an actual
   landing page (hero, feature sections, pricing) ahead of Phase 6's
   plans/billing work.
5. **Login/register** — functional, plain forms; needs real layout,
   branding, and error-state treatment (currently a thrown error from
   the server action, not a styled inline message).
6. **Dashboard (website list)** — currently a bare list; needs real
   cards/table with status indicators, health-score visualization, and
   an empty state that's more than a sentence.
7. **Website results page** — the most feature-dense page (ownership
   verification, schedule control, crawl job history, findings table,
   diff view, AI recommendations, report downloads) and currently the
   plainest. This is the highest-value target: real severity color
   coding (beyond text labels), a real findings table with sort/filter,
   a visual health-score element (not just a number), and a genuine
   crawl-progress indicator instead of a static "pending/running" pill.
8. **Reports themselves** (PDF/HTML) — currently plain pdfkit output and
   a bare HTML document. Needs real branding/layout treatment per the
   original spec's "attractive and understandable to nontechnical
   business owners" requirement — this is customer-facing output, so it
   arguably deserves earlier attention than internal dashboard screens.

## Interaction / motion (after the above, not before)

9. Crawl-progress visualization (live page-count, current URL, issue-
   discovery feed) — currently just a status pill that needs a manual
   page reload to update; this is as much a real-time-data problem
   (polling or streaming updates) as a design one.
10. Purposeful transitions per the brief: page transitions, skeleton
    loading states, animated health-score reveal, chart transitions once
    there are actual charts (there are none yet — findings are a plain
    table, no historical trend visualization exists despite the diff
    data being available).
11. `prefers-reduced-motion` support, once any motion exists to respect it.

## Explicitly deferred until there's something to point at

- Figma/21st.dev MCP integration for sourcing components — not used yet;
  the brief says to detect availability and fall back to normal tooling,
  which is what's happened by necessity so far.
- Visual regression testing, accessibility audit pass (WCAG) — makes
  more sense once there's an actual design to regress against.

## Recommendation

Start with #1–3 (tokens, type, components) as their own slice, since
every later item depends on them and redoing per-page styling twice
would be wasted work. Then #7 and #8 (website results page + the
reports themselves) are the highest-value next targets since they're
where a real customer spends the most time and forms their first
impression of report quality.
