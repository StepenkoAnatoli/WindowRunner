import type { LLMProvider } from "./types.js";
import { MockProvider } from "./mock.js";

/**
 * Provider registry for the server boot path.
 *
 * This checkout ships exactly one provider: the offline mock. The OpenAI-
 * compatible and Anthropic adapters described in AGENTS.md are not present
 * (see docs/research/2026-09-19-checkout-integrity-audit.md), so naming any
 * other provider is a configuration error and is reported as one at boot,
 * rather than silently falling back to the mock. Add real adapters here when
 * they exist; nothing else in the boot path needs to change.
 */
export const AVAILABLE_PROVIDERS = ["mock"] as const;

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

export function createProvider(name: string): LLMProvider {
  if (!isAvailableProvider(name)) {
    throw new UnknownProviderError(name);
  }
  switch (name) {
    case "mock":
      return new MockProvider();
  }
}
