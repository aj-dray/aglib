import type { Content, ContentPart } from "../content.js";
import type { ToolCall, Usage } from "../session/entry.js";
import type { Message } from "../session/messages.js";
import type { ToolSpec } from "../tools/tool.js";
import type { Failure, Result } from "../result.js";
import type { JsonValue } from "../json.js";

/**
 * One provider call.
 *
 * There is no model *name* here, and that is the point: a model is a value.
 * `createAnthropicModel({ apiKey, model })` is the provider, the credential and
 * the model together, and choosing a different one is choosing a different
 * `Model` — which is already how the loop passes a cheaper one to compaction.
 *
 * A name would have to be resolved, and resolving is what goes wrong. The one
 * application that had a name field to use encoded provider and model into it
 * as `provider/model`, then had to split it back out — ambiguously, because a
 * provider's own ids contain slashes (`z-ai/glm-5.2`), so the split was
 * "up to the first one" with a comment apologising for it. One field, two facts.
 * Names leave this library as observations — `ModelResponse.model` says what
 * actually served — and never enter it as selections.
 */
export interface ModelRequest {
  messages: readonly Message[];
  tools?: readonly ToolSpec[];
  maxOutputTokens?: number;
  /**
   * Only for providers that still accept sampling controls. The current
   * Anthropic models reject it outright, so that adapter does not send it —
   * declaring the option here and dropping it there is the honest shape, since
   * the alternative is a request the provider 400s.
   */
  temperature?: number;
  /**
   * How much the model should think before answering, where it can. Named
   * levels rather than a token budget, because a budget is the one thing no
   * two providers agree on — and the providers that had one have since removed
   * it. Each adapter maps a level to its own control; one that has none
   * ignores it rather than failing.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** End the cacheable prefix after this many messages. A decision about one request only. */
  cacheAfter?: number;
  signal?: AbortSignal;
}

export type ModelDelta =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool-call.delta"; callId: string; arguments: string };

export interface ModelResponse {
  message: { content: Content; calls?: readonly ToolCall[] };
  finishReason: "stop" | "tool-calls" | "length" | "refusal";
  usage: Usage;
  model?: string;
}

export interface ModelError extends Failure {
  code: "auth" | "rate-limit" | "context-length" | "cancelled" | "provider" | "failed";
}

/**
 * One method. Streaming is not a second contract: a caller that wants the whole
 * response drains the generator and takes its return value, so no adapter has
 * to implement the same normalization twice.
 */
export interface Model {
  readonly id: string;
  generate(request: ModelRequest): AsyncGenerator<ModelDelta, Result<ModelResponse, ModelError>>;
}

/** Drains a generation and returns only its outcome. */
export async function collect(
  generation: AsyncGenerator<ModelDelta, Result<ModelResponse, ModelError>>,
): Promise<Result<ModelResponse, ModelError>> {
  let step = await generation.next();
  while (!step.done) step = await generation.next();
  return step.value;
}

/**
 * The vocabulary an adapter needs, re-exported from the port it implements.
 * An adapter imports these from here rather than reaching into the modules that
 * own them, so the port is the whole of its surface — every one of them appears
 * in a type above, which is what makes this the place to get them.
 */
export type { ContentPart, Message, ToolCall, ToolSpec, Usage };
