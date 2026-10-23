import { describe, it, expect } from "vitest";
import { detectAiCrawlerAccessIssues, KNOWN_AI_CRAWLER_USER_AGENTS } from "./supplementary-rules";

describe("detectAiCrawlerAccessIssues", () => {
  it("flags a bot with its own 'Disallow: /' group, one finding per bot, each category=ai_crawler_blocked", () => {
    const robotsTxt = "User-agent: GPTBot\nDisallow: /\n";
    const findings = detectAiCrawlerAccessIssues(robotsTxt, true);
    const blocked = findings.filter((f) => f.category === "ai_crawler_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].title).toContain("GPTBot");
    expect(blocked[0].severity).toBe("medium");
    expect(blocked[0].evidence.userAgent).toBe("GPTBot");
  });

  it("produces one finding row per blocked bot when multiple are blocked (never a combined finding)", () => {
    const robotsTxt = [
      "User-agent: GPTBot",
      "Disallow: /",
      "",
      "User-agent: ClaudeBot",
      "Disallow: /",
      "",
      "User-agent: PerplexityBot",
      "Disallow: /",
    ].join("\n");
    const findings = detectAiCrawlerAccessIssues(robotsTxt, true);
    const blocked = findings.filter((f) => f.category === "ai_crawler_blocked");
    expect(blocked).toHaveLength(3);
    const botNames = blocked.map((f) => f.evidence.userAgent);
    expect(botNames).toEqual(expect.arrayContaining(["GPTBot", "ClaudeBot", "PerplexityBot"]));
  });

  it("does NOT flag a bot that has no dedicated group, even if 'User-agent: *' disallows some paths", () => {
    const robotsTxt = "User-agent: *\nDisallow: /private/\n";
    const findings = detectAiCrawlerAccessIssues(robotsTxt, true);
    expect(findings.filter((f) => f.category === "ai_crawler_blocked")).toHaveLength(0);
  });

  it("does NOT flag a bot whose group only disallows a specific path, not the whole site", () => {
    const robotsTxt = "User-agent: GPTBot\nDisallow: /private/\n";
    const findings = detectAiCrawlerAccessIssues(robotsTxt, true);
    expect(findings.filter((f) => f.category === "ai_crawler_blocked")).toHaveLength(0);
  });

  it("does NOT flag a bot whose root Disallow is overridden by an explicit Allow: /", () => {
    const robotsTxt = "User-agent: GPTBot\nDisallow: /\nAllow: /\n";
    const findings = detectAiCrawlerAccessIssues(robotsTxt, true);
    expect(findings.filter((f) => f.category === "ai_crawler_blocked")).toHaveLength(0);
  });

  it("checks every known, documented AI-bot user-agent, not just one", () => {
    const groupsBlockingAll = KNOWN_AI_CRAWLER_USER_AGENTS.map(
      (b) => `User-agent: ${b.userAgent}\nDisallow: /`
    ).join("\n\n");
    const findings = detectAiCrawlerAccessIssues(groupsBlockingAll, true);
    const blocked = findings.filter((f) => f.category === "ai_crawler_blocked");
    expect(blocked).toHaveLength(KNOWN_AI_CRAWLER_USER_AGENTS.length);
  });

  it("flags missing llms.txt as a low-severity informational finding, not an error", () => {
    const findings = detectAiCrawlerAccessIssues("User-agent: *\nDisallow:\n", false);
    const missing = findings.filter((f) => f.category === "llms_txt_missing");
    expect(missing).toHaveLength(1);
    expect(missing[0].severity).toBe("low");
  });

  it("does NOT flag llms_txt_missing when llms.txt was found", () => {
    const findings = detectAiCrawlerAccessIssues("User-agent: *\nDisallow:\n", true);
    expect(findings.filter((f) => f.category === "llms_txt_missing")).toHaveLength(0);
  });

  it("handles a null robots.txt (unreachable) by treating no bot as explicitly blocked, but still checks llms.txt", () => {
    const findings = detectAiCrawlerAccessIssues(null, false);
    expect(findings.filter((f) => f.category === "ai_crawler_blocked")).toHaveLength(0);
    expect(findings.filter((f) => f.category === "llms_txt_missing")).toHaveLength(1);
  });
});
