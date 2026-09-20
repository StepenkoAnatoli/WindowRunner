import type { LLMProvider } from "./types.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { AnthropicProvider, DEFAULT_ANTHROPIC_BASE_URL } from "./anthropic.js";
import { withRetry, DEFAULT_MODEL_MAX_RETRIES } from "./retry.js";
import { ConfigError, ENV, type ModelConfig } from "../config.js";
import type { ProviderProfile } from "../provider-profiles.js";

/**
 * Provider registry for the server boot path.
 *
 * Three providers: the offline `mock` (default; never touches the network),
 * `openai-compatible` (providers/openai-compatible.ts), which covers OpenAI,
 * OpenRouter, Ollama, LM Studio, vLLM, Groq and Gemini's OpenAI endpoint, and
 * `anthropic` (providers/anthropic.ts, native Messages API). Both network
 * adapters read WINDOWS_RUNNER_MODEL_BASE_URL / WINDOWS_RUNNER_MODEL /
 * WINDOWS_RUNNER_MODEL_API_KEY and are wrapped in providers/retry.ts.
 * Naming anything else is a configuration error reported at boot, never a
 * silent fallback to the mock.
 */
export const AVAILABLE_PROVIDERS = ["mock", "openai-compatible", "anthropic"] as const;

export type ProviderName = (typeof AVAILABLE_PROVIDERS)[number];

export class UnknownProviderError extends Error {
  readonly requested: string;
  readonly available: readonly string[];

  constructor(requested: string) {
    super(
      `provider "${requested}" is not available in this checkout ` +
        `(available: ${AVAILABLE_PROVIDERS.join(", ")}). ` +
        `Set WINDOWS_RUNNER_PROVIDER to one of the available providers.`
    );
    this.name = "UnknownProviderError";
    this.requested = requested;
    this.available = AVAILABLE_PROVIDERS;
  }
}

export function isAvailableProvider(name: string): name is ProviderName {
  return (AVAILABLE_PROVIDERS as readonly string[]).includes(name);
}

export function createProvider(name: string, model?: ModelConfig, log?: (line: string) => void): LLMProvider {
  if (!isAvailableProvider(name)) {
    throw new UnknownProviderError(name);
  }
  switch (name) {
    case "mock":
      return new MockProvider();
    case "openai-compatible":
    case "anthropic": {
      if (!model?.model) throw new Error(`${name}: WINDOWS_RUNNER_MODEL is required`);
      const opts = { baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey, systemPrompt: DEFAULT_SYSTEM_PROMPT };
      const inner = name === "anthropic" ? new AnthropicProvider(opts) : new OpenAICompatibleProvider(opts);
      return withRetry(inner, {
        maxRetries: model.maxRetries,
        onRetry: ({ attempt, delayMs, error }) => log?.(`model: ${error.code} (${error.status ?? "network"}); retry ${attempt}/${model.maxRetries} in ${delayMs}ms`),
      });
    }
  }
}

/**
 * Options shared by every provider built from a profile (dashboard path).
 * The env boot path and the profile path must behave identically: same retry
 * policy (WINDOWS_RUNNER_MODEL_MAX_RETRIES) and same system prompt.
 */
export interface ProfileProviderOptions {
  /** Extra attempts for retryable errors. Default: DEFAULT_MODEL_MAX_RETRIES (2). */
  maxRetries?: number;
  /** System prompt prepended when the transcript has none. */
  systemPrompt?: string;
  /** Called before each retry; used for the server log. */
  onRetry?: (info: { attempt: number; delayMs: number; error: import("./types.js").ProviderError }) => void;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/**
 * Build an LLMProvider from a dashboard-managed profile (provider-profiles.ts).
 * Reuses the same adapters as the env boot path — no per-profile adapter
 * classes. `anthropic` profiles omit baseUrl by default (official API);
 * `openai-compatible` requires it (validated at save time, enforced here too).
 */
export function createProviderFromProfile(profile: ProviderProfile, options: ProfileProviderOptions = {}): LLMProvider {
  const { maxRetries = DEFAULT_MODEL_MAX_RETRIES, systemPrompt, onRetry, fetch } = options;
  let inner: LLMProvider;
  switch (profile.kind) {
    case "mock":
      inner = new MockProvider();
      break;
    case "openai-compatible": {
      if (!profile.baseUrl) {
        throw new ConfigError(`provider profile "${profile.id}": baseUrl is required for openai-compatible profiles`, ENV.modelBaseUrl);
      }
      inner = new OpenAICompatibleProvider({ baseUrl: profile.baseUrl, model: profile.model, apiKey: profile.apiKey, systemPrompt, fetch });
      break;
    }
    case "anthropic":
      inner = new AnthropicProvider({
        baseUrl: profile.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL,
        model: profile.model,
        apiKey: profile.apiKey,
        systemPrompt,
        fetch,
      });
      break;
    default:
      throw new ConfigError(`provider profile "${profile.id}": unknown kind ${(profile as { kind: string }).kind}`, ENV.provider);
  }
  return withRetry(inner, { maxRetries, onRetry });
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are windows-runner, a coding agent working inside one project folder. " +
  "Use the provided tools to inspect and change files and to run commands; paths are relative to the project root and cannot leave it. " +
  "Some actions require the user's approval; if a tool reports APPROVAL_DENIED, do not retry it. " +
  "Be concise and report what you changed.";
