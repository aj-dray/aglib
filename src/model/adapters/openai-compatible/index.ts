import type {
  ContentPart, Message, Model, ModelDelta, ModelError, ModelRequest, ModelResponse, ToolCall, ToolSpec, Usage,
} from "../../model.js";
import { err, ok, type Result } from "../../../result.js";
import { textOf } from "../../../content.js";
import type { JsonValue } from "../../../json.js";
import { isWaitStatus, retrying, type RetryOptions } from "../../retry.js";

export interface OpenAiCompatibleOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  headers?: Readonly<Record<string, string>>;
  /**
   * How this endpoint spells reasoning effort. OpenAI takes `reasoning_effort`;
   * OpenRouter takes `reasoning: { effort }` and forwards it to whoever is
   * serving the model. Sending both is not compatibility — OpenAI rejects the
   * request outright — so the dialect is declared rather than guessed.
   */
  effortParameter?: "reasoning_effort" | "reasoning" | "none";
  /**
   * How this endpoint spells a cache breakpoint, where it has one. Most models
   * on this wire cache a repeated prefix by themselves and have no field for
   * it — plain OpenAI rejects one it does not know — so the default sends none.
   * OpenRouter takes Anthropic's `cache_control` on a text part and forwards
   * it to the models that cache nothing without one.
   */
  cacheBreakpoint?: "cache_control" | "none";
  /**
   * A refusal this endpoint means as a wait, beyond the statuses every HTTP
   * wire means so. Retried before the first delta like those, and reported as
   * a rate limit when the retries run out.
   */
  isWait?: RetryOptions["isWait"];
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * The OpenAI chat-completions wire, which almost every provider now speaks —
 * OpenRouter, Together, Groq, vLLM, Ollama. One adapter, one base URL.
 */
export function createOpenAiCompatibleModel(options: OpenAiCompatibleOptions): Model {
  const call = retrying(options.fetch ?? fetch, { ...(options.isWait ? { isWait: options.isWait } : {}) });
  const provider = `openai-compatible:${options.baseUrl.replace(/\/+$/, "")}`;
  const marking = options.cacheBreakpoint === "cache_control";
  return {
    id: `openai-compatible:${options.model}`,

    async *generate(request: ModelRequest): AsyncGenerator<ModelDelta, Result<ModelResponse, ModelError>> {
      let response: Response;
      try {
        response = await call(`${options.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
            ...options.headers,
          },
          body: JSON.stringify({
            model: options.model,
            messages: encodeConversation(request.messages, provider, marking ? breakpoints(request) : new Set()),
            ...(request.tools?.length ? { tools: request.tools.map(encodeTool) } : {}),
            ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...encodeEffort(request.effort, options.effortParameter ?? "reasoning_effort"),
            stream: true,
            stream_options: { include_usage: true },
          }),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (error) {
        return err(transportError(error, request.signal));
      }

      if (!response.ok) return err(await httpError(response, options.isWait));
      if (!response.body) return err({ code: "provider", message: "No response body", retryable: true });

      const text: string[] = [];
      const calls = new Map<number, { callId: string; name: string; arguments: string }>();
      let finish: ModelResponse["finishReason"] = "stop";
      let usage: Usage = {};
      let model: string | undefined;
      const reasoningDetails: JsonValue[] = [];
      let sawReasoningDetails = false;
      const reasoning: string[] = [];
      const reasoningContent: string[] = [];

      // A stream that dies mid-body — cancelled, dropped, truncated — must come
      // back as a typed failure like any other. Without this the generator throws,
      // `run.result` rejects instead of resolving `cancelled`, no `run.finished`
      // is ever committed, and the activation stays open until its claim expires.
      try {
        for await (const event of sseLines(response.body)) {
          if (event === "[DONE]") break;
          let frame: ChatFrame;
          try { frame = JSON.parse(event) as ChatFrame; } catch { continue; }
          model ??= frame.model;
          if (frame.usage) usage = decodeUsage(frame.usage);

          const choice = frame.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finish = decodeFinish(choice.finish_reason);

          const content = choice.delta?.content;
          if (content) { text.push(content); yield { type: "text.delta", text: content }; }

          const reasoningDelta = choice.delta?.reasoning;
          const reasoningContentDelta = choice.delta?.reasoning_content;
          if (reasoningDelta !== undefined) reasoning.push(reasoningDelta);
          if (reasoningContentDelta !== undefined) reasoningContent.push(reasoningContentDelta);
          const visibleReasoning = reasoningDelta ?? reasoningContentDelta;
          if (visibleReasoning) yield { type: "reasoning.delta", text: visibleReasoning };
          if (choice.delta?.reasoning_details !== undefined) {
            sawReasoningDetails = true;
            appendReasoningDetails(reasoningDetails, choice.delta.reasoning_details);
          }

          for (const fragment of choice.delta?.tool_calls ?? []) {
            // Providers stream tool arguments in fragments, keyed by position;
            // only the first fragment carries the id and the name.
            const existing = calls.get(fragment.index) ?? {
              callId: fragment.id ?? `call_${fragment.index}`,
              name: fragment.function?.name ?? "",
              arguments: "",
            };
            if (fragment.id) existing.callId = fragment.id;
            if (fragment.function?.name) existing.name = fragment.function.name;
            if (fragment.function?.arguments) {
              existing.arguments += fragment.function.arguments;
              yield { type: "tool-call.delta", callId: existing.callId, arguments: fragment.function.arguments };
            }
            calls.set(fragment.index, existing);
          }
        }
      } catch (error) {
        return err(transportError(error, request.signal));
      }

      const collected: ToolCall[] = [...calls.values()]
        .map((call) => ({ callId: call.callId, name: call.name, arguments: call.arguments || "{}" }));

      const state = reasoningState(reasoningDetails, sawReasoningDetails, reasoning, reasoningContent);
      return ok({
        message: { content: text.join(""), ...(collected.length ? { calls: collected } : {}) },
        finishReason: collected.length && finish === "stop" ? "tool-calls" : finish,
        usage,
        ...(model ? { model } : {}),
        ...(state.length ? { providerState: { provider, items: state } } : {}),
      });
    },
  };
}

/**
 * OpenRouter is this wire with a fixed base URL, attribution headers, and two
 * facts of its own.
 *
 * It caches Claude only when asked. Every other model it serves reads a
 * repeated prefix from cache on its own; a Claude request without a
 * `cache_control` mark is read in full every turn, at full price. The mark
 * goes on the models that need it and on no other: whether the providers that
 * cache by themselves ignore a mark is not something its documentation says,
 * and a strict one could refuse the request.
 *
 * It answers 402 for two different things. One is an account with no credit,
 * which is a refusal. The other is the account's credit being reserved by its
 * own other requests still in flight, which clears when they finish — the
 * commonest failure an agent serving several sessions at once will see, and a
 * wait. The body's structured `error.metadata.reason` tells them apart.
 */
export function createOpenRouterModel(input: {
  apiKey: string; model: string; appUrl?: string; appName?: string; fetch?: typeof fetch;
}): Model {
  return createOpenAiCompatibleModel({
    apiKey: input.apiKey,
    baseUrl: "https://openrouter.ai/api/v1",
    model: input.model,
    effortParameter: "reasoning",
    cacheBreakpoint: /^~?anthropic\//.test(input.model) ? "cache_control" : "none",
    isWait: inFlightBudgetExhausted,
    headers: {
      ...(input.appUrl ? { "http-referer": input.appUrl } : {}),
      ...(input.appName ? { "x-title": input.appName } : {}),
    },
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
}

async function inFlightBudgetExhausted(response: Response): Promise<boolean> {
  if (response.status !== 402) return false;
  const body = await response.clone().json().catch(() => undefined) as
    { error?: { metadata?: { reason?: unknown } } } | undefined;
  return body?.error?.metadata?.reason === "in_flight_budget_exhausted";
}

function encodeEffort(
  effort: ModelRequest["effort"],
  parameter: "reasoning_effort" | "reasoning" | "none",
): Record<string, unknown> {
  if (!effort || parameter === "none") return {};
  return parameter === "reasoning" ? { reasoning: { effort } } : { reasoning_effort: effort };
}

/**
 * Which messages carry a breakpoint: the same three places the Anthropic
 * adapter marks, for the same reasons it gives.
 *
 * The prefix ends where the caller says. When that is at or past the leading
 * run of system messages, the first and the last of them are marked — the last
 * makes a conversation's own prefix reusable across its turns, the first makes
 * the standing instructions every conversation shares reusable across
 * conversations. A boundary past the system run marks the message it ends on
 * as well. Three at most, inside a budget of four.
 */
function breakpoints(request: ModelRequest): ReadonlySet<number> {
  const boundary = request.cacheAfter;
  if (boundary === undefined) return new Set();
  const lead = leadingSystem(request.messages);
  const marked = new Set<number>();
  if (lead > 0 && boundary >= lead) marked.add(0).add(lead - 1);
  if (boundary > lead && boundary <= request.messages.length) marked.add(boundary - 1);
  return marked;
}

/** How far the leading run of system messages reaches: the standing instructions and the run's context. */
function leadingSystem(messages: readonly Message[]): number {
  let lead = 0;
  while (lead < messages.length && messages[lead]!.role === "system") lead += 1;
  return lead;
}

function encodeConversation(
  messages: readonly Message[], provider: string, marked: ReadonlySet<number>,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let images: ContentPart[] = [];
  const flush = () => {
    if (images.length) out.push({ role: "user", content: encodeContent(images) });
    images = [];
  };
  const lead = leadingSystem(messages);
  messages.forEach((message, index) => {
    // The wire accepts only text in tool replies. Keep every reply in a parallel
    // batch adjacent before supplying its images as associated user content.
    if (message.role !== "tool") flush();
    const encoded = encodeMessage(message, provider);
    // A system message past the leading run is the turn's context, which the
    // projection places after the cache boundary so that the prefix before it
    // can be read back. This wire sends it as `user`, its text unchanged.
    // OpenRouter folds every `system` message into Gemini's one
    // `systemInstruction`, and Gemini's implicit cache treats that instruction
    // as immutable, so a request that ends in a `system` message reads nothing
    // from cache — 0 tokens of a 15,138-token prefix, whether repeated byte for
    // byte or with one line changed — where the same line as a trailing `user`
    // message reads 12,189. DeepSeek does the same, 0 against 15,104; GLM reads
    // 11,520 either way. In production that was Gemini 3.8 Flash falling from
    // a nine-tenths daily cache share to none, at full input price every turn.
    if (message.role === "system" && index >= lead) encoded["role"] = "user";
    if (marked.has(index)) mark(encoded);
    out.push(encoded);
    if (message.role === "tool" && typeof message.content !== "string") {
      const media = message.content.filter((part) => part.type === "image");
      if (media.length) images.push({ type: "text", text: `Images from tool call ${message.callId}:` }, ...media);
    }
  });
  flush();
  return out;
}

/**
 * A breakpoint lands on a text part, so a bare string becomes one part to
 * carry it. A message with no text — an assistant turn that only called tools,
 * a user turn that is only an image — has nowhere to put one and gets none.
 */
function mark(encoded: Record<string, unknown>): void {
  const content = encoded["content"];
  if (typeof content === "string") {
    if (content) encoded["content"] = [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
    return;
  }
  if (!Array.isArray(content)) return;
  const last = content.findLast((part: Record<string, unknown>) => part["type"] === "text") as
    Record<string, unknown> | undefined;
  if (last) last["cache_control"] = { type: "ephemeral" };
}

function encodeMessage(message: Message, provider: string): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.callId, content: textOf(message.content) };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: textOf(message.content) || null,
      ...decodeReasoningState(message, provider),
      ...(message.calls?.length
        ? {
            tool_calls: message.calls.map((call) => ({
              id: call.callId, type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    };
  }
  return { role: message.role, content: encodeContent(message.content) };
}

function encodeContent(content: Message["content"]): unknown {
  if (typeof content === "string") return content;
  const parts: Record<string, unknown>[] = [];
  for (const part of content as readonly ContentPart[]) {
    if (part.type === "text") { parts.push({ type: "text", text: part.text }); continue; }
    if (part.type === "image") {
      const url = part.source.kind === "url" ? part.source.url : `data:${part.mediaType};base64,${part.source.data}`;
      parts.push({ type: "image_url", image_url: { url } });
    }
    // Files and opaque blocks have no place on this wire. Dropping them beats
    // stringifying them into something the model would read as prose.
  }
  const only = parts.length === 1 ? parts[0] : undefined;
  return only?.type === "text" ? only.text : parts;
}

function reasoningState(
  details: readonly JsonValue[],
  sawDetails: boolean,
  reasoning: readonly string[],
  reasoningContent: readonly string[],
): JsonValue[] {
  const state: Record<string, JsonValue> = {};
  if (sawDetails) state["reasoning_details"] = details;
  if (!sawDetails && reasoning.length) state["reasoning"] = reasoning.join("");
  if (!sawDetails && reasoningContent.length) state["reasoning_content"] = reasoningContent.join("");
  return Object.keys(state).length ? [state] : [];
}

function decodeReasoningState(message: Extract<Message, { role: "assistant" }>, provider: string) {
  if (message.providerState?.provider !== provider) return {};
  const state: Record<string, JsonValue> = {};
  for (const item of message.providerState.items) {
    const value = record(item);
    const details = value?.["reasoning_details"];
    if (Array.isArray(details)) state["reasoning_details"] = details;
    for (const field of ["reasoning", "reasoning_content"] as const) {
      if (typeof value?.[field] === "string") state[field] = value[field];
    }
  }
  return state;
}

/** Rebuild the complete blocks OpenRouter's chat stream fragments by type. */
function appendReasoningDetails(target: JsonValue[], incoming: readonly JsonValue[]): void {
  for (const raw of incoming) {
    const detail = record(raw);
    if (!detail) {
      target.push(clone(raw));
      continue;
    }
    const field = detail?.["type"] === "reasoning.text" ? "text"
      : detail?.["type"] === "reasoning.summary" ? "summary"
      : undefined;
    const previous = record(target.at(-1));
    if (!field || !previous || previous["type"] !== detail["type"] || !compatible(previous, detail, field)) {
      target.push(clone(raw));
      continue;
    }

    const merged: Record<string, JsonValue> = { ...previous };
    for (const [key, value] of Object.entries(detail)) {
      if (key === field) continue;
      if (value !== null || merged[key] === undefined) merged[key] = value;
    }
    merged[field] = `${typeof previous[field] === "string" ? previous[field] : ""}${
      typeof detail[field] === "string" ? detail[field] : ""
    }`;
    target[target.length - 1] = merged;
  }
}

function compatible(
  left: Readonly<Record<string, JsonValue>>,
  right: Readonly<Record<string, JsonValue>>,
  payload: string,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (key === payload) continue;
    const a = left[key];
    const b = right[key];
    if (a === undefined || a === null || b === undefined || b === null) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return true;
}

const record = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : undefined;

const clone = (value: JsonValue): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

const encodeTool = (tool: ToolSpec) => ({
  type: "function",
  function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: false },
});

const decodeFinish = (reason: string): ModelResponse["finishReason"] =>
  reason === "tool_calls" ? "tool-calls"
  : reason === "length" ? "length"
  : reason === "content_filter" ? "refusal"
  : "stop";

const decodeUsage = (usage: ChatUsage): Usage => ({
  // Carried, not computed. A router picks an upstream provider per request and
  // adds its own margin, so what it charged is a thing only it can say — and
  // the frame carrying it is the one this adapter already reads.
  ...(typeof usage.cost === "number" ? { costUsd: usage.cost } : {}),
  // `prompt_tokens` is the whole prompt, and both `cached_tokens` and
  // `cache_write_tokens` are counted inside it. `Usage` keeps the three input
  // counts disjoint, so the cached parts come out here rather than every
  // caller having to know which wire produced the number it is holding.
  ...(usage.prompt_tokens !== undefined
    ? {
        inputTokens: Math.max(
          usage.prompt_tokens
            - (usage.prompt_tokens_details?.cached_tokens ?? 0)
            - (usage.prompt_tokens_details?.cache_write_tokens ?? 0),
          0,
        ),
      }
    : {}),
  ...(usage.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
  ...(usage.prompt_tokens_details?.cached_tokens !== undefined
    ? { cacheReadTokens: usage.prompt_tokens_details.cached_tokens } : {}),
  ...(usage.prompt_tokens_details?.cache_write_tokens !== undefined
    ? { cacheWriteTokens: usage.prompt_tokens_details.cache_write_tokens } : {}),
});

/**
 * A refusal, or a wait the retries did not outlast. The second keeps a
 * retryable code: the provider never said the request was wrong, and a caller
 * with the time to try again later is told so.
 */
async function httpError(response: Response, isWait: RetryOptions["isWait"]): Promise<ModelError> {
  const wait = isWaitStatus(response.status) || (await isWait?.(response) ?? false);
  const body = await response.text().catch(() => "");
  const code: ModelError["code"] =
    response.status === 401 || response.status === 403 ? "auth"
    : response.status === 400 && /context|token/i.test(body) ? "context-length"
    : wait && (response.status === 429 || response.status === 402) ? "rate-limit"
    : wait ? "provider"
    : "failed";
  return {
    code,
    message: `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 400)}` : ""}`,
    retryable: wait,
  };
}

function transportError(error: unknown, signal?: AbortSignal): ModelError {
  if (signal?.aborted) return { code: "cancelled", message: "Generation cancelled", retryable: false };
  return { code: "provider", message: error instanceof Error ? error.message : String(error), retryable: true };
}

/** Server-sent events, reassembled across chunk boundaries. */
async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
      newline = buffer.indexOf("\n");
    }
  }
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /**
   * `cache_write_tokens` is OpenRouter's, reported when the model it routed to
   * wrote the marked prefix; plain OpenAI sends only `cached_tokens`.
   */
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  /**
   * What this generation was charged. OpenRouter sets it on every response and
   * calls it credits, whose base currency is US dollars; plain OpenAI and the
   * self-hosted endpoints on this wire do not send it at all, so it is absent
   * rather than zero there.
   */
  cost?: number;
}
interface ChatFrame {
  model?: string;
  usage?: ChatUsage;
  choices?: readonly {
    finish_reason?: string | null;
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      reasoning_details?: readonly JsonValue[];
      tool_calls?: readonly { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}
