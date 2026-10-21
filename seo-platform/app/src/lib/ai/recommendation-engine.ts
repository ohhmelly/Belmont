/**
 * AI recommendation engine (Phase 4).
 *
 * Takes the real `findings` rows for one crawl job and produces
 * `ai_recommendations` rows. Every hard requirement from the Phase 4
 * spec is enforced structurally here, not just by convention:
 *
 *  - Grounding: `findingIds` on every returned recommendation is built
 *    by THIS module from the real finding objects it was given — never
 *    parsed out of the AI's own response text. A hallucinated finding
 *    id from the model is structurally impossible to surface, because
 *    the model is never asked to produce ids at all.
 *  - No fabricated metrics: enforced by the system prompt
 *    (ai/prompt.ts) AND by never including any search-volume/backlink/
 *    ranking field in the data we hand the model in the first place —
 *    it cannot report a number it was never given a slot for.
 *  - Graceful degradation: every `provider.complete()` call is wrapped;
 *    on failure/timeout/unavailability we fall back to a deterministic
 *    template built only from the finding's own already-trusted fields
 *    (category/severity/url/title/description), and label
 *    `metadata.generatedBy = "template-fallback"` so nothing is ever
 *    presented as AI-verified when it wasn't.
 *  - No write-back: this module only reads `findings` rows (via its
 *    parameters) and returns plain data to be inserted into
 *    `ai_recommendations`. It never calls the crawler, never fetches
 *    the customer's site, and has no code path that could modify it.
 *
 * Priority ranking: `priority` on each recommendation is exactly the
 * grounding finding's own `severity` (never invented). For ordering
 * recommendations within a list (e.g. the dev-task list, or which
 * findings get an individual AI explanation when there are many), we
 * use `priorityScore()` below — a simple, fully documented heuristic:
 * severity weight (critical=40/high=30/medium=20/low=10) plus +5 if the
 * finding's category is one that blocks crawling/indexing/navigation
 * outright (not just a quality issue). This is a transparent tiebreaker
 * for ordering only; it never changes the stored `priority` label.
 */
import type { AiProvider } from "./provider";
import {
  buildFindingExplanationPrompt,
  buildTitleMetaSuggestionPrompt,
  buildInternalLinkingPrompt,
  buildStructuredDataPrompt,
  buildAuditSummaryPrompt,
  buildDevTaskPrompt,
  type FindingLike,
} from "./prompt";

export type RecommendationKind =
  | "finding_explanation"
  | "title_meta_suggestion"
  | "internal_linking"
  | "structured_data"
  | "dev_task"
  | "audit_summary";

export interface RecommendationDraft {
  crawlJobId: string;
  websiteId: string;
  kind: RecommendationKind;
  findingIds: string[];
  priority: "critical" | "high" | "medium" | "low" | null;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}

/** A finding row as read back from Postgres (id is required and real). */
export interface EngineFinding extends FindingLike {
  id: string;
}

const SEVERITY_WEIGHT: Record<string, number> = { critical: 40, high: 30, medium: 20, low: 10 };

/** Categories that block crawling/indexing/navigation outright, not just a quality issue. See module doc. */
const BLOCKING_CATEGORIES = new Set([
  "missing_title",
  "broken_link",
  "server_error",
  "redirect_loop",
  "ssrf_blocked_redirect",
  "unsafe_crawl_target",
  "canonical_conflict",
]);

export function priorityScore(finding: EngineFinding): number {
  const base = SEVERITY_WEIGHT[finding.severity] ?? 10;
  return base + (BLOCKING_CATEGORIES.has(finding.category) ? 5 : 0);
}

const TITLE_META_CATEGORIES = new Set([
  "missing_title",
  "duplicate_title",
  "missing_meta_description",
  "duplicate_meta_description",
]);
const LINKING_CATEGORIES = new Set(["orphan_page", "orphan_page_summary"]);
const STRUCTURED_DATA_CATEGORIES = new Set(["structured_data_invalid"]);

export interface EngineOptions {
  /** Cap on how many findings get an individual AI-written explanation (highest priorityScore first). Keeps run time/cost bounded. */
  maxExplanations?: number;
  /** Cap on how many findings get a dev-task ticket. */
  maxDevTasks?: number;
  /** Cap on how many findings get a title/meta suggestion call. */
  maxTitleMetaSuggestions?: number;
}

const DEFAULTS: Required<EngineOptions> = {
  maxExplanations: 12,
  maxDevTasks: 12,
  maxTitleMetaSuggestions: 8,
};

/**
 * Code-level enforcement of the "never fabricate metrics" hard
 * requirement, in ADDITION to the prompt-level instruction in
 * ai/prompt.ts. This is deliberately a second, independent layer: a
 * real run of this engine against a real small local model (qwen2.5:0.5b)
 * showed the prompt-level instruction alone is not 100% reliable — one
 * recommendation out of 29 in that run still referenced "search volume"
 * despite being explicitly told not to (see the Phase 4 completion
 * report for the exact text). Prompting a model is best-effort, not a
 * guarantee, so any output mentioning one of these forbidden concepts —
 * regardless of whether it attaches a specific invented number — is
 * discarded entirely and replaced with the deterministic template, never
 * edited/stripped-and-kept (editing model text increases the risk of
 * leaving a subtler fabricated claim behind).
 */
const FORBIDDEN_METRIC_PATTERN =
  /search volume|backlinks?\b|ranking position|serp position|rank(ed|ing)?\s*#?\d|monthly (traffic|visitors|searches)|click-through rate|\bctr\b|conversion rate|domain authority|page authority|organic traffic/i;

function violatesMetricPolicy(text: string): boolean {
  return FORBIDDEN_METRIC_PATTERN.test(text);
}

async function safeComplete(
  provider: AiProvider,
  aiAvailable: boolean,
  messages: Parameters<AiProvider["complete"]>[0],
  fallback: () => string
): Promise<{ text: string; generatedBy: string; model: string }> {
  if (aiAvailable) {
    try {
      const text = await provider.complete(messages);
      if (violatesMetricPolicy(text)) {
        return { text: fallback(), generatedBy: "template-fallback-metric-guard", model: "none" };
      }
      return { text: text.trim(), generatedBy: provider.name, model: provider.model };
    } catch {
      // fall through to template fallback — AI being unreachable/erroring must never throw out of the engine.
    }
  }
  return { text: fallback(), generatedBy: "template-fallback", model: "none" };
}

function templateExplanation(finding: EngineFinding): string {
  return `${finding.title} (${finding.category}, severity: ${finding.severity}) was detected at ${finding.url}. ${finding.description || "No further description was captured by the crawler."} Review and fix this issue on the affected page.`;
}

function templateDevTask(finding: EngineFinding): string {
  return `Fix "${finding.title}" (${finding.category}) on ${finding.url}.`;
}

function templateTitleMeta(finding: EngineFinding): { title: string; meta: string } {
  const slugFromUrl = (() => {
    try {
      const u = new URL(finding.url);
      const segment = u.pathname.split("/").filter(Boolean).pop() ?? u.hostname;
      return segment.replace(/[-_]+/g, " ").trim() || u.hostname;
    } catch {
      return finding.url;
    }
  })();
  return {
    title: slugFromUrl.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60),
    meta: `Learn more about ${slugFromUrl}.`.slice(0, 155),
  };
}

/**
 * Generate every AI recommendation draft for one crawl job's findings.
 * Pure function over its inputs + the given provider — does not touch
 * the database itself (callers insert the returned drafts).
 */
export async function generateRecommendations(
  crawlJobId: string,
  websiteId: string,
  websiteUrl: string,
  allFindings: EngineFinding[],
  provider: AiProvider,
  options: EngineOptions = {}
): Promise<RecommendationDraft[]> {
  const opts = { ...DEFAULTS, ...options };
  const aiAvailable = provider.isConfigured() && (await provider.isAvailable());

  const drafts: RecommendationDraft[] = [];

  const byPriorityDesc = [...allFindings].sort((a, b) => priorityScore(b) - priorityScore(a));

  // 1. Per-finding plain-English explanations for the most significant findings.
  const toExplain = byPriorityDesc.filter((f) => f.severity !== "low").slice(0, opts.maxExplanations);
  for (const finding of toExplain) {
    const { messages } = buildFindingExplanationPrompt(finding);
    const { text, generatedBy, model } = await safeComplete(provider, aiAvailable, messages, () =>
      templateExplanation(finding)
    );
    drafts.push({
      crawlJobId,
      websiteId,
      kind: "finding_explanation",
      findingIds: [finding.id],
      priority: finding.severity as RecommendationDraft["priority"],
      title: `Explanation: ${finding.title}`,
      body: text,
      metadata: { generatedBy, model, priorityScore: priorityScore(finding), category: finding.category, url: finding.url },
    });
  }

  // 2. Title/meta-description suggestions — ONLY for findings that are actually a title/meta issue.
  const titleMetaFindings = byPriorityDesc
    .filter((f) => TITLE_META_CATEGORIES.has(f.category))
    .slice(0, opts.maxTitleMetaSuggestions);
  for (const finding of titleMetaFindings) {
    const { messages } = buildTitleMetaSuggestionPrompt(finding);
    const fallbackPair = templateTitleMeta(finding);
    const { text, generatedBy, model } = await safeComplete(provider, aiAvailable, messages, () =>
      `TITLE: ${fallbackPair.title}\nMETA: ${fallbackPair.meta}`
    );
    const titleMatch = text.match(/TITLE:\s*(.+)/i);
    const metaMatch = text.match(/META:\s*(.+)/i);
    drafts.push({
      crawlJobId,
      websiteId,
      kind: "title_meta_suggestion",
      findingIds: [finding.id],
      priority: finding.severity as RecommendationDraft["priority"],
      title: `Title/meta suggestion: ${finding.url}`,
      body: text,
      metadata: {
        generatedBy,
        model,
        category: finding.category,
        url: finding.url,
        suggestedTitle: (titleMatch?.[1] ?? fallbackPair.title).trim().slice(0, 70),
        suggestedMetaDescription: (metaMatch?.[1] ?? fallbackPair.meta).trim().slice(0, 170),
      },
    });
  }

  // 3. Internal-linking suggestions where orphan-page / link-depth findings exist.
  const linkingFindings = allFindings.filter((f) => LINKING_CATEGORIES.has(f.category));
  if (linkingFindings.length > 0) {
    const { messages } = buildInternalLinkingPrompt(linkingFindings);
    const { text, generatedBy, model } = await safeComplete(provider, aiAvailable, messages, () =>
      `${linkingFindings.length} page(s) are not reachable via internal links: ${linkingFindings
        .slice(0, 10)
        .map((f) => f.url)
        .join(", ")}${linkingFindings.length > 10 ? ", …" : ""}. Add a link to each from a relevant hub page, category page, or the site navigation/sitemap.`
    );
    drafts.push({
      crawlJobId,
      websiteId,
      kind: "internal_linking",
      findingIds: linkingFindings.map((f) => f.id),
      priority: "low",
      title: "Internal linking / orphan pages",
      body: text,
      metadata: { generatedBy, model, affectedCount: linkingFindings.length },
    });
  }

  // 4. Structured-data recommendations where that finding category exists.
  const structuredDataFindings = allFindings.filter((f) => STRUCTURED_DATA_CATEGORIES.has(f.category));
  if (structuredDataFindings.length > 0) {
    const { messages } = buildStructuredDataPrompt(structuredDataFindings);
    const { text, generatedBy, model } = await safeComplete(provider, aiAvailable, messages, () =>
      `${structuredDataFindings.length} page(s) have invalid structured data (JSON-LD that fails to parse): ${structuredDataFindings
        .map((f) => f.url)
        .join(", ")}. Validate the JSON-LD block's syntax and ensure it uses a schema.org type matching the page's content.`
    );
    drafts.push({
      crawlJobId,
      websiteId,
      kind: "structured_data",
      findingIds: structuredDataFindings.map((f) => f.id),
      priority: "medium",
      title: "Structured data issues",
      body: text,
      metadata: { generatedBy, model, affectedCount: structuredDataFindings.length },
    });
  }

  // 5. Developer remediation task list — short, paste-into-a-ticket items for the top findings.
  const devTaskFindings = byPriorityDesc.filter((f) => f.severity === "critical" || f.severity === "high").slice(0, opts.maxDevTasks);
  for (const finding of devTaskFindings) {
    const { messages } = buildDevTaskPrompt(finding);
    const { text, generatedBy, model } = await safeComplete(provider, aiAvailable, messages, () => templateDevTask(finding));
    drafts.push({
      crawlJobId,
      websiteId,
      kind: "dev_task",
      findingIds: [finding.id],
      priority: finding.severity as RecommendationDraft["priority"],
      title: `Dev task: ${finding.category}`,
      body: text,
      metadata: { generatedBy, model, url: finding.url },
    });
  }

  // 6. Overall audit summary — references every finding considered, using only real counted stats.
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const f of allFindings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
  }
  const healthScoreForSummary = Math.max(
    0,
    Math.min(100, Math.round(100 - allFindings.reduce((acc, f) => acc + ({ critical: 8, high: 4, medium: 2, low: 0.5 }[f.severity] ?? 1), 0)))
  );
  {
    const { messages } = buildAuditSummaryPrompt({
      totalFindings: allFindings.length,
      bySeverity,
      byCategory,
      healthScore: healthScoreForSummary,
      websiteUrl,
    });
    const { text, generatedBy, model } = await safeComplete(provider, aiAvailable, messages, () => {
      const sevSummary = Object.entries(bySeverity)
        .map(([s, c]) => `${c} ${s}`)
        .join(", ");
      return `This audit of ${websiteUrl} found ${allFindings.length} issue(s) (${sevSummary || "none"}), giving a health score of ${healthScoreForSummary}/100. Address critical and high-severity issues first.`;
    });
    drafts.push({
      crawlJobId,
      websiteId,
      kind: "audit_summary",
      findingIds: allFindings.map((f) => f.id),
      priority: null,
      title: `Audit summary — ${websiteUrl}`,
      body: text,
      metadata: { generatedBy, model, bySeverity, byCategory, healthScore: healthScoreForSummary },
    });
  }

  return drafts;
}
