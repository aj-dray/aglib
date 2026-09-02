/**
 * Where a vendor agent's own requests go.
 *
 * The important thing this file says is that **the bridge is the last of three
 * options, not the first**. Both agents here speak wires that real providers
 * already serve, and going straight to one keeps everything a translation
 * costs: prompt caching, a thinking budget, real token counts, and error
 * classes a client's retry logic reads.
 *
 *   - **Anthropic** serves the Anthropic wire, obviously.
 *   - **OpenRouter** serves it too, natively — "Claude Code speaks its native
 *     protocol directly to OpenRouter. No local proxy server is required."
 *     Pi reaches the same account over the OpenAI wire, which OpenRouter also
 *     serves and pi-ai already has a provider for.
 *   - **Anything else** cannot, and that is what `serveAnthropicWire` is for:
 *     the same job Ollama's Anthropic endpoint does for a local model.
 *
 * An earlier version of this recipe sent everything through the bridge, which
 * meant the two cases needing nothing were quietly paying for the one that did.
 */
import type { Model } from "aglib/model";
import { serveAnthropicWire } from "./wire.ts";

export type Via = "anthropic" | "openrouter" | "openai" | "bridge";

export interface Route {
  /** Where requests go. */
  baseUrl: string;
  token: string;
  /** The wire spoken there. Pi needs to be told; Claude Code only speaks one. */
  api: "anthropic-messages" | "openai-completions";
  via: Via;
  close(): Promise<void>;
}

const noClose = async (): Promise<void> => {};

const credential = (name: string, provider: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (needed for --provider ${provider})`);
  return value;
};

/**
 * The route for an agent that speaks Anthropic's wire and nothing else.
 *
 * `model` is a thunk because building one costs a credential lookup, and the
 * two direct routes need no `Model` at all — the provider is the model.
 */
export function anthropicRoute(input: { provider: string; model: () => Model; force?: boolean }): Route {
  // Asked for on purpose. Worth having as a choice rather than a fallback: it
  // is the only way to exercise the translation against a provider that did not
  // need it, and someone pointing an agent at a local model wants exactly this.
  if (input.force) {
    const forced = serveAnthropicWire({ model: input.model() });
    return { baseUrl: forced.url, token: forced.token, api: "anthropic-messages", via: "bridge", close: forced.close };
  }
  if (input.provider === "anthropic") {
    return {
      baseUrl: "https://api.anthropic.com",
      token: credential("ANTHROPIC_API_KEY", "anthropic"),
      api: "anthropic-messages", via: "anthropic", close: noClose,
    };
  }
  if (input.provider === "openrouter") {
    return {
      baseUrl: "https://openrouter.ai/api",
      token: credential("OPENROUTER_API_KEY", "openrouter"),
      api: "anthropic-messages", via: "openrouter", close: noClose,
    };
  }
  const wire = serveAnthropicWire({ model: input.model() });
  return { baseUrl: wire.url, token: wire.token, api: "anthropic-messages", via: "bridge", close: wire.close };
}

/**
 * The route for Pi, which speaks several and is told which.
 *
 * OpenRouter is reached on the OpenAI wire here rather than the Anthropic one,
 * because that is the provider pi-ai already ships a descriptor for and it
 * costs nothing to use it.
 */
export function piRoute(input: { provider: string; model: () => Model; force?: boolean }): Route {
  if (input.force) return anthropicRoute(input);
  if (input.provider === "openrouter") {
    return {
      baseUrl: "https://openrouter.ai/api/v1",
      token: credential("OPENROUTER_API_KEY", "openrouter"),
      api: "openai-completions", via: "openrouter", close: noClose,
    };
  }
  if (input.provider === "openai") {
    return {
      baseUrl: "https://api.openai.com/v1",
      token: credential("OPENAI_API_KEY", "openai"),
      api: "openai-completions", via: "openai", close: noClose,
    };
  }
  return anthropicRoute(input);
}
