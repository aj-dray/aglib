/**
 * The Anthropic wire, read rather than written.
 *
 * `adapters/anthropic` speaks this wire outbound: a `ModelRequest` becomes an
 * HTTP call to Anthropic. This is the same vocabulary in the other direction —
 * a request that arrived *on* the wire becomes a `ModelRequest`, and a
 * generation becomes the frames a client expects back. Put a socket in front of
 * it and any `Model` behind this port answers to any Anthropic-wire client:
 * the Claude Agent SDK pointed at `ANTHROPIC_BASE_URL`, most obviously, which
 * is how a harness built on that SDK runs on a model Anthropic never served.
 *
 * **It lives in a recipe, and the reason is the difference between a client and
 * an impersonation.** `adapters/anthropic` is a client: Anthropic publishes
 * that wire and we send on it. This claims to *be* Anthropic to something that
 * believes it, and a partial impersonation is a promise the package cannot
 * keep — it would have to track a protocol it does not own, for ever, to stay
 * true. Held here it is one recipe's plumbing, and its gaps are a recipe's
 * problem.
 *
 * **It is also a last resort rather than the path.** OpenRouter serves the
 * Anthropic wire directly, and Anthropic obviously does, so an agent pointed at
 * either needs nothing from this file — and gets prompt caching, thinking and
 * real token accounting that routing through here would cost it. What this is
 * for is the case neither covers: a model that cannot speak the wire at all,
 * which is the same thing Ollama's Anthropic endpoint does for a local model.
 *
 * **Not a server.** There is no listener here, no route, and no credential
 * check. Serving is deployment and belongs to whoever is deploying; this is the
 * translation that would otherwise be written inside their handler.
 *
 * Two deliberate omissions:
 *
 * **Arguments do not stream.** A `tool-call.delta` carries a call id and a
 * fragment, and Anthropic's `content_block_start` needs the tool's *name*
 * before any fragment can be sent. The name is only known once the generation
 * returns, so tool calls are emitted whole at the end rather than fabricated
 * early. A client sees the block appear complete instead of forming.
 *
 * **Reasoning is dropped.** A `thinking` block on this wire carries a
 * signature the client replays back, and a signature we invented is one no
 * provider would accept on the way out. Emitting nothing is the honest
 * reading of a field we cannot sign.
 */
import { z } from "zod";
import { err, ok, type Failure, type JsonValue, type Result } from "aglib";
import type { Content, ContentPart } from "aglib";
import type { Message, ModelDelta, ModelError, ModelRequest, ModelResponse, ToolSpec } from "aglib/model";
import type { ToolCall } from "aglib/session";

export interface WireError extends Failure {
  code: "invalid";
}

/** What arrived, split into the part this package models and the part it echoes. */
export interface WireRequest {
  request: Omit<ModelRequest, "signal">;
  /** Whether the client asked for frames or one body. */
  stream: boolean;
  /**
   * The model the client named. An observation, never a selection: the `Model`
   * is already chosen by whoever composed the server, and this is carried only
   * so the response can say what the client called it.
   */
  model: string;
}

/** A cache breakpoint. Carried, not ignored: dropping it silently is how a bridge defeats caching. */
const cacheControl = z.object({ type: z.string(), ttl: z.string().optional() }).optional();

const textBlock = z.object({ type: z.literal("text"), text: z.string(), cache_control: cacheControl });
const imageBlock = z.object({
  type: z.literal("image"),
  source: z.union([
    z.object({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
    z.object({ type: z.literal("url"), url: z.string() }),
  ]),
});
const toolUseBlock = z.object({
  type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown(),
});
const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.union([textBlock, imageBlock]))]).optional(),
  is_error: z.boolean().optional(),
});

const requestSchema = z.object({
  model: z.string(),
  max_tokens: z.number().int().positive(),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  messages: z.array(z.object({
    // `system` is here because current Anthropic models take an operator
    // instruction mid-conversation, as a message rather than an edit to the
    // top-level field. Refusing it is refusing the clients that send it.
    role: z.enum(["user", "assistant", "system"]),
    content: z.union([
      z.string(),
      z.array(z.union([textBlock, imageBlock, toolUseBlock, toolResultBlock])),
    ]),
  })),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.unknown(),
  })).optional(),
  temperature: z.number().optional(),
  stream: z.boolean().optional(),
  output_config: z.object({ effort: z.enum(["low", "medium", "high", "xhigh", "max"]) }).partial().optional(),
  /**
   * Accepted so effort is not silently lost. The Claude Code harness asks for
   * thinking with a budget, and a schema that dropped the field turned every
   * `--effort` into no effort at all, with nothing to notice it by.
   */
  thinking: z.object({
    type: z.string(),
    budget_tokens: z.number().int().optional(),
  }).optional(),
});

/**
 * A request off the wire, as this package's own vocabulary.
 *
 * Anthropic has two roles and puts tool traffic in content blocks; we have four
 * roles and put it in fields. The conversion is the whole of this function, and
 * it is why a `tool_result` inside a user turn comes out as a `tool` message
 * and the surrounding text stays a `user` one.
 */
export function decodeAnthropicRequest(body: unknown): Result<WireRequest, WireError> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return err<WireError>({ code: "invalid", message: z.prettifyError(parsed.error), retryable: false });
  }
  const wire = parsed.data;
  const messages: Message[] = [];

  if (typeof wire.system === "string") messages.push({ role: "system", content: wire.system });
  else if (wire.system) messages.push({ role: "system", content: wire.system.map((block) => block.text).join("\n") });

  for (const message of wire.messages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    // Tool results leave the turn they arrived in: they are their own role here.
    for (const block of message.content) {
      if (block.type === "tool_result") {
        messages.push({
          role: "tool",
          callId: block.tool_use_id,
          content: typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map(decodeBlock).filter((part): part is ContentPart => part !== undefined),
          ...(block.is_error ? { isError: true } : {}),
        });
      }
    }

    const parts = message.content
      .filter((block) => block.type === "text" || block.type === "image")
      .map(decodeBlock)
      .filter((part): part is ContentPart => part !== undefined);
    const calls: ToolCall[] = message.content
      .filter((block): block is z.infer<typeof toolUseBlock> => block.type === "tool_use")
      .map((block) => ({ callId: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }));

    if (message.role === "assistant") {
      if (parts.length || calls.length) {
        messages.push({ role: "assistant", content: parts, ...(calls.length ? { calls } : {}) });
      }
    } else if (parts.length) {
      messages.push({ role: message.role === "system" ? "system" : "user", content: parts });
    }
  }

  const tools: ToolSpec[] = (wire.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: (tool.input_schema ?? {}) as JsonValue,
  }));

  // The prefix a client asked to keep. Ours is a count of messages rather than
  // a mark on one, so the boundary is the last block that carried the mark.
  const marked = wire.messages.reduce((at, message, index) =>
    Array.isArray(message.content) && message.content.some((block) =>
      block.type === "text" && block.cache_control !== undefined) ? index + 1 : at, 0);
  const systemMarked = typeof wire.system === "object"
    && wire.system.some((block) => block.cache_control !== undefined);
  const cacheAfter = marked > 0 ? marked : (systemMarked ? 1 : undefined);

  return ok({
    model: wire.model,
    stream: wire.stream ?? false,
    request: {
      messages,
      maxOutputTokens: wire.max_tokens,
      ...(tools.length ? { tools } : {}),
      ...(wire.temperature !== undefined ? { temperature: wire.temperature } : {}),
      ...(effortOf(wire) ? { effort: effortOf(wire)! } : {}),
      ...(cacheAfter !== undefined ? { cacheAfter } : {}),
    },
  });
}

/**
 * How hard to think, from whichever field the client used.
 *
 * `output_config.effort` is the current one and wins. A `thinking` budget is
 * the older shape and is bucketed against the three the Claude Code harness
 * actually sets, so a round trip through here returns the level it asked for.
 */
function effortOf(wire: z.infer<typeof requestSchema>): ModelRequest["effort"] | undefined {
  if (wire.output_config?.effort) return wire.output_config.effort;
  const budget = wire.thinking?.budget_tokens;
  if (budget === undefined) return undefined;
  return budget <= 2048 ? "low" : budget <= 8192 ? "medium" : "high";
}

function decodeBlock(block: { type: string; [key: string]: unknown }): ContentPart | undefined {
  if (block.type === "text") return { type: "text", text: block["text"] as string };
  if (block.type === "image") {
    const source = block["source"] as { type: string; media_type?: string; data?: string; url?: string };
    return {
      type: "image",
      mediaType: source.media_type ?? "application/octet-stream",
      source: source.type === "url"
        ? { kind: "url", url: source.url! }
        : { kind: "inline", data: source.data! },
    };
  }
  return undefined;
}

const stopReason: Readonly<Record<ModelResponse["finishReason"], string>> = {
  "stop": "end_turn",
  "tool-calls": "tool_use",
  "length": "max_tokens",
  "refusal": "refusal",
};

/** The response body a non-streaming client expects. */
export function encodeAnthropicMessage(input: { response: ModelResponse; model: string; id: string }): JsonValue {
  return {
    id: input.id,
    type: "message",
    role: "assistant",
    model: input.response.model ?? input.model,
    content: encodeContent(input.response.message.content, input.response.message.calls),
    stop_reason: stopReason[input.response.finishReason],
    stop_sequence: null,
    usage: {
      input_tokens: input.response.usage.inputTokens ?? 0,
      output_tokens: input.response.usage.outputTokens ?? 0,
      ...(input.response.usage.cacheReadTokens !== undefined
        ? { cache_read_input_tokens: input.response.usage.cacheReadTokens } : {}),
      ...(input.response.usage.cacheWriteTokens !== undefined
        ? { cache_creation_input_tokens: input.response.usage.cacheWriteTokens } : {}),
    },
  };
}

/**
 * The HTTP status an error deserves.
 *
 * Flattening everything to 500 erased the distinctions a client's retry logic
 * reads: an expired credential retried for ever, a rate limit retried at once,
 * a context overflow retried identically.
 */
export const statusOf = (error: WireError | ModelError): number =>
  error.code === "auth" ? 401
  : error.code === "rate-limit" ? 429
  : error.code === "invalid" || error.code === "context-length" ? 400
  : 500;

/** The error body, for a request this package could not serve. */
export function encodeAnthropicError(error: WireError | ModelError): JsonValue {
  const type = error.code === "auth" ? "authentication_error"
    : error.code === "rate-limit" ? "rate_limit_error"
    : error.code === "invalid" || error.code === "context-length" ? "invalid_request_error"
    : "api_error";
  return { type: "error", error: { type, message: error.message } };
}

function encodeContent(content: Content, calls: readonly ToolCall[] | undefined): JsonValue {
  const blocks: JsonValue[] = [];
  const parts: readonly ContentPart[] = typeof content === "string"
    ? (content ? [{ type: "text", text: content }] : [])
    : content;
  for (const part of parts) if (part.type === "text") blocks.push({ type: "text", text: part.text });
  for (const call of calls ?? []) {
    blocks.push({ type: "tool_use", id: call.callId, name: call.name, input: safeJson(call.arguments) });
  }
  return blocks;
}

/** One server-sent event, named and already JSON. The framing is the caller's. */
export interface WireEvent { event: string; data: JsonValue }

/**
 * A generation as the frames a streaming client expects.
 *
 * Text is forwarded as it arrives. Everything else waits for the return value,
 * for the reasons at the top of this file.
 */
export async function* encodeAnthropicStream(input: {
  generation: AsyncGenerator<ModelDelta, Result<ModelResponse, ModelError>>;
  model: string;
  id: string;
}): AsyncGenerator<WireEvent> {
  // Anthropic reports input usage here, and we do not have it yet: a `Model`
  // answers with what it spent when the generation returns. Rather than invent
  // a zero — which a client would sum and bill against — the counts are sent
  // whole on `message_delta` below, where the real ones exist.
  yield {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: input.id, type: "message", role: "assistant", model: input.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: {},
      },
    },
  };

  let index = 0;
  let open = false;
  let step = await input.generation.next();
  for (; !step.done; step = await input.generation.next()) {
    const delta = step.value;
    if (delta.type !== "text.delta") continue;
    if (!open) {
      yield { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } };
      open = true;
    }
    yield { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: delta.text } } };
  }
  if (open) {
    yield { event: "content_block_stop", data: { type: "content_block_stop", index } };
    index += 1;
  }

  const result = step.value;
  if (!result.ok) {
    yield { event: "error", data: encodeAnthropicError(result.error) };
    return;
  }

  // Text that never arrived as a delta still has to be sent: an adapter is
  // entitled to return a whole message without streaming any of it.
  if (!open) {
    const whole = encodeContent(result.value.message.content, undefined) as { type: string; text: string }[];
    for (const block of whole) {
      yield { event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } };
      yield { event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } } };
      yield { event: "content_block_stop", data: { type: "content_block_stop", index } };
      index += 1;
    }
  }

  for (const call of result.value.message.calls ?? []) {
    yield {
      event: "content_block_start",
      data: { type: "content_block_start", index, content_block: { type: "tool_use", id: call.callId, name: call.name, input: {} } },
    };
    yield {
      event: "content_block_delta",
      data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: call.arguments } },
    };
    yield { event: "content_block_stop", data: { type: "content_block_stop", index } };
    index += 1;
  }

  yield {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason[result.value.finishReason], stop_sequence: null },
      // Every count the provider reported, including the input and cache ones
      // `message_start` could not know. An absent count stays absent.
      usage: {
        ...(result.value.usage.inputTokens !== undefined ? { input_tokens: result.value.usage.inputTokens } : {}),
        ...(result.value.usage.outputTokens !== undefined ? { output_tokens: result.value.usage.outputTokens } : {}),
        ...(result.value.usage.cacheReadTokens !== undefined
          ? { cache_read_input_tokens: result.value.usage.cacheReadTokens } : {}),
        ...(result.value.usage.cacheWriteTokens !== undefined
          ? { cache_creation_input_tokens: result.value.usage.cacheWriteTokens } : {}),
      },
    },
  };
  yield { event: "message_stop", data: { type: "message_stop" } };
}

const safeJson = (raw: string): JsonValue => {
  try { return JSON.parse(raw) as JsonValue; } catch { return {}; }
};
