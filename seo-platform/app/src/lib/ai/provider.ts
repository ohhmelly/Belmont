/**
 * AI provider interface (Phase 4).
 *
 * Per docs/ARCHITECTURE.md, Ollama (a local, self-hosted model server
 * speaking an OpenAI-compatible HTTP API) is the default AI provider,
 * and it is OPTIONAL: every caller of `getAiProvider()` must tolerate
 * `isAvailable()` returning false (Ollama not configured, not running,
 * or the configured model not pulled) and degrade gracefully — never
 * throw out of a crawl or report just because AI is unreachable. See
 * src/lib/ai/recommendation-engine.ts for how that degradation works.
 *
 * Outbound-call safety: `OLLAMA_BASE_URL` is operator-set deployment
 * configuration (like DATABASE_URL), not end-user input, but per the
 * project's "every outbound call goes through the one safety module"
 * rule, the call to it is still routed through `safeFetch`
 * (crawl-safety.ts) — the same pre-flight URL/scheme validation, DNS
 * pinning, timeout and response-size cap used for crawling. The one
 * difference from crawling an arbitrary site is that the Ollama origin
 * is deliberately treated as a trusted, explicitly-allowlisted origin
 * (the same escape hatch crawl-safety.ts already defines for our own
 * fixture server in tests) because it is expected to be an internal
 * address (`localhost`, or the `ollama` service name inside Docker
 * Compose) — rejecting it as "private" would make the feature
 * unusable. If OLLAMA_BASE_URL is ever sourced from end-user/tenant
 * input rather than operator deployment config, that input must be
 * revalidated with `validateUrlForCrawl` WITHOUT this allowlist
 * exception before being used here.
 */
import { safeFetch, CrawlSafetyError } from "../crawl-safety";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  temperature?: number;
  maxTokens?: number;
  /** Request timeout in ms for this single completion call. */
  timeoutMs?: number;
}

export interface AiProvider {
  /** Short machine-readable name, stored in ai_recommendations.metadata.generatedBy. */
  readonly name: string;
  /** Model identifier, stored in ai_recommendations.metadata.model. */
  readonly model: string;
  /** True if this provider has the configuration it needs to attempt a call (does not mean it will succeed). */
  isConfigured(): boolean;
  /** A cheap real reachability check (short timeout). Never throws. */
  isAvailable(): Promise<boolean>;
  /** Run one chat completion. Throws on failure — callers must catch and degrade. */
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string>;
}

const DEFAULT_AVAILABILITY_TIMEOUT_MS = 3_000;
const DEFAULT_COMPLETE_TIMEOUT_MS = 60_000;

/**
 * Real Ollama provider, talking to its OpenAI-compatible
 * `/v1/chat/completions` endpoint (confirmed against a real local
 * Ollama 0.5.1 server + qwen2.5:0.5b in this environment — see the
 * Phase 4 completion report for the exact request/response).
 */
export class OllamaProvider implements AiProvider {
  readonly name = "ollama";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly allowlistOrigin: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.allowlistOrigin = new URL(this.baseUrl).origin;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await safeFetch(`${this.baseUrl}/api/tags`, {
        allowlistOrigins: [this.allowlistOrigin],
        timeoutMs: DEFAULT_AVAILABILITY_TIMEOUT_MS,
        maxBytes: 1024 * 1024,
      });
      if (res.status !== 200) return false;
      const parsed = JSON.parse(res.body.toString("utf8")) as { models?: { name: string }[] };
      // Reachable AND the configured model is actually pulled — both are
      // required for `complete()` to have a real chance of succeeding.
      return Boolean(parsed.models?.some((m) => m.name === this.model || m.name.startsWith(`${this.model.split(":")[0]}:`)));
    } catch {
      return false;
    }
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 400,
      stream: false,
    });

    let res;
    try {
      res = await safeFetch(`${this.baseUrl}/v1/chat/completions`, {
        allowlistOrigins: [this.allowlistOrigin],
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        timeoutMs: opts.timeoutMs ?? DEFAULT_COMPLETE_TIMEOUT_MS,
        maxBytes: 4 * 1024 * 1024,
      });
    } catch (err) {
      if (err instanceof CrawlSafetyError) {
        throw new Error(`Ollama call blocked/failed by safety pre-flight: ${err.message}`);
      }
      throw err;
    }

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Ollama returned HTTP ${res.status}: ${res.body.toString("utf8").slice(0, 500)}`);
    }

    const parsed = JSON.parse(res.body.toString("utf8")) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("Ollama response had no completion content");
    }
    return content;
  }
}

/**
 * Deterministic, clearly-labeled MOCK provider used only when no real AI
 * provider is configured/reachable. It performs NO inference — it builds
 * a templated sentence purely from the structural fields already present
 * on the request (never from pattern-matching the untrusted crawled
 * content), so it can never be confused for a real AI judgment. Every
 * caller must check `name === "stub"` (or metadata.generatedBy) before
 * presenting this as an "AI recommendation" to a user — the recommendation
 * engine labels it "template-fallback" rather than AI-generated.
 */
export class StubAiProvider implements AiProvider {
  readonly name = "stub";
  readonly model = "none (template fallback, not an AI model)";

  isConfigured(): boolean {
    return true;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async complete(messages: ChatMessage[]): Promise<string> {
    const userMsg = messages.filter((m) => m.role === "user").pop();
    return (
      "[No AI model available — this is a deterministic placeholder, not an AI-generated answer.] " +
      `Review the finding details above (task: ${(userMsg?.content ?? "").slice(0, 80).replace(/\s+/g, " ")}...).`
    );
  }
}

export interface AiProviderConfig {
  baseUrl?: string;
  model?: string;
}

/**
 * Build the configured provider from the environment, per
 * docs/ARCHITECTURE.md: Ollama by default via OLLAMA_BASE_URL, falling
 * back to the stub when it's unset. This does NOT check reachability —
 * callers should call `isAvailable()` before relying on `complete()`.
 */
export function createAiProviderFromEnv(config: AiProviderConfig = {}): AiProvider {
  const baseUrl = config.baseUrl ?? process.env.OLLAMA_BASE_URL;
  const model = config.model ?? process.env.OLLAMA_MODEL ?? "qwen2.5:0.5b";
  if (!baseUrl) return new StubAiProvider();
  try {
    return new OllamaProvider(baseUrl, model);
  } catch {
    // Malformed OLLAMA_BASE_URL — degrade rather than crash.
    return new StubAiProvider();
  }
}
