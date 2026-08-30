/**
 * The model behind the native harness and behind `delegate`.
 *
 * The five external agents bring their own; this is for the work the service
 * does itself, and it fails with a typed error rather than throwing so a tool
 * can report a missing key to the agent that asked.
 */
import { createOpenRouterModel, createOpenAiCompatibleModel } from "aglib/model/adapters/openai-compatible";
import { createAnthropicModel } from "aglib/model/adapters/anthropic";
import type { Model } from "aglib/model";
import type { Usage } from "aglib";
import { err, ok, type Failure, type Result } from "aglib";
import { secret } from "./credentials.ts";

const defaults = {
  openrouter: "deepseek/deepseek-v4-flash",
  openai: "gpt-5-nano",
  anthropic: "claude-haiku-4-5-20251001",
} as const;

/** Which connection each provider authenticates with. One name, resolved centrally. */
const connections = { openrouter: "openrouter", openai: "openai", anthropic: "anthropic" } as const;

/**
 * A provider, a credential and one of that provider's model ids, together.
 *
 * Effort is not here: it is a knob over one call, not part of which model this
 * is, and the loop takes it. Accepting it here and dropping it — which this did
 * — meant a session that asked for `effort: "high"` on the native harness
 * silently got none, against a capability table promising `effort: full`.
 */
export function chooseModel(input: {
  provider?: keyof typeof defaults | "default" | "custom" | "ollama";
  model?: string;
}): Result<Model, Failure> {
  const provider = !input.provider || input.provider === "default" || input.provider === "custom" || input.provider === "ollama"
    ? "openrouter" : input.provider;
  const apiKey = secret(connections[provider]);
  if (!apiKey) {
    return err<Failure>({
      code: "unavailable",
      message: `Not connected to ${provider}. Add it in the service's connections.`,
      retryable: false,
    });
  }
  const model = input.model || defaults[provider];
  if (provider === "anthropic") return ok(createAnthropicModel({ apiKey, model }));
  if (provider === "openai") {
    return ok(createOpenAiCompatibleModel({ apiKey, baseUrl: "https://api.openai.com/v1", model }));
  }
  return ok(createOpenRouterModel({ apiKey, model, appName: "aglib-agent-service" }));
}

/**
 * What a million tokens costs, per kind — this deployment's table, not the
 * library's.
 *
 * The library reports token counts and no money on purpose: published rates
 * move faster than a release, so a table shipped inside it would go stale with
 * nothing failing to say so. That argument applies to this file too. These
 * figures are examples for the models this service defaults to; an operator
 * running it for real replaces them, and a model that is not in here is priced
 * by nobody, which is the honest answer rather than free.
 */
const RATES: Readonly<Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>> = {
  "deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.0625 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/**
 * What one generation cost, or nothing where this deployment has no rate.
 *
 * The library reports token counts and no money, and enforces no ceiling over
 * them: rates are this deployment's and so is what to do when a run gets
 * expensive. This is the arithmetic, and `RunResult.usage` is what it reads.
 *
 * `model` is what the provider said actually served the request, which is not
 * always the id that was asked for — OpenRouter may answer with a dated variant,
 * and a harness that reports no model at all (Claude Code) reaches here with
 * none. Nothing is not zero: a run under a ceiling stops at a generation this
 * table could not cover, rather than billing it short.
 */
export function priceOf(generation: { model?: string; usage: Usage }): number | undefined {
  const { model, usage } = generation;
  // What the provider charged, where it said so. Better than any table here:
  // it is the real figure, and for a router no table could produce it — the
  // upstream provider is chosen per request and the margin is the router's.
  if (usage.costUsd !== undefined) return usage.costUsd;
  const rates = model ? RATES[model] : undefined;
  if (!rates || usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  // The three counts are disjoint, so each is billed at its own rate and none
  // is subtracted out of another. Subtracting was wrong on any wire that
  // already reported input net of the cache, and wrong silently: the result
  // was clamped at zero rather than being allowed to go negative.
  return (
    usage.inputTokens * rates.input
    + cacheRead * rates.cacheRead
    + cacheWrite * rates.cacheWrite
    + usage.outputTokens * rates.output
  ) / 1_000_000;
}
