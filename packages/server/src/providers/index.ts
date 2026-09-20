import type { LLMProvider } from "./types.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { ModelConfig } from "../config.js";

/**
 * Provider registry for the server boot path.
 *
 * Two providers: the offline `mock` (default; never touches the network) and
 * `openai-compatible` (providers/openai-compatible.ts), which covers OpenAI,
 * OpenRouter, Ollama, LM Studio, vLLM, Groq and Gemini's OpenAI endpoint via
 * WINDOWS_RUNNER_MODEL_BASE_URL / WINDOWS_RUNNER_MODEL / WINDOWS_RUNNER_MODEL_API_KEY.
 * Naming anything else is a configuration error reported at boot, never a
 * silent fallback to the mock.
 */
export const AVAILABLE_PROVIDERS = ["mock", "openai-compatible"] as const;

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

export function createProvider(name: string, model?: ModelConfig): LLMProvider {
  if (!isAvailableProvider(name)) {
    throw new UnknownProviderError(name);
  }
  switch (name) {
    case "mock":
      return new MockProvider();
    case "openai-compatible": {
      if (!model?.model) throw new Error("openai-compatible: WINDOWS_RUNNER_MODEL is required");
      return new OpenAICompatibleProvider({ baseUrl: model.baseUrl, model: model.model, apiKey: model.apiKey, systemPrompt: DEFAULT_SYSTEM_PROMPT });
    }
  }
}

export const DEFAULT_SYSTEM_PROMPT =
  "You are windows-runner, a coding agent working inside one project folder. " +
  "Use the provided tools to inspect and change files and to run commands; paths are relative to the project root and cannot leave it. " +
  "Some actions require the user's approval; if a tool reports APPROVAL_DENIED, do not retry it. " +
  "Be concise and report what you changed.";
