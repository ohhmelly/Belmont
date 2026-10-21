/**
 * The normalized finding shape every crawl-time check — whether it comes
 * from siteone-crawler's own analyzer or from our supplementary
 * rule-engine pass — is mapped into. See docs/INTEGRATION_ARCHITECTURE.md
 * for which categories come from which source.
 */
export type Severity = "critical" | "high" | "medium" | "low";

export type SourceEngine = "siteone-crawler" | "supplementary-rules" | "crawler-adapter";

export interface NormalizedFinding {
  sourceEngine: SourceEngine;
  url: string;
  canonicalUrl?: string | null;
  httpStatus?: number | null;
  severity: Severity;
  category: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
}
