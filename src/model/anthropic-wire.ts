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
 * It lives here and not in a recipe because it is the inverse of the adapter
 * beside it. The mapping between our four message roles and Anthropic's two
 * plus content blocks is one fact; written twice it would drift, and the
 * direction that drifted would be the one with no test on it. It needs no
 * dependency to say so — `core-dependencies` is about vendor libraries, and
 * this is arithmetic over JSON.
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
import { err, ok, type Failure, type Result } from "../result.js";
import type { JsonValue } from "../json.js";
import type { Content, ContentPart } from "../content.js";
import type { Message, ModelDelta, ModelError, ModelRequest, ModelResponse, ToolCall, ToolSpec } from "./model.js";

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

const textBlock = z.object({ type: z.literal("text"), text: z.string() });
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

  return ok({
    model: wire.model,
    stream: wire.stream ?? false,
    request: {
      messages,
      maxOutputTokens: wire.max_tokens,
      ...(tools.length ? { tools } : {}),
      ...(wire.temperature !== undefined ? { temperature: wire.temperature } : {}),
      ...(wire.output_config?.effort ? { effort: wire.output_config.effort } : {}),
    },
  });
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
  yield {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: input.id, type: "message", role: "assistant", model: input.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
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
      usage: { output_tokens: result.value.usage.outputTokens ?? 0 },
    },
  };
  yield { event: "message_stop", data: { type: "message_stop" } };
}

const safeJson = (raw: string): JsonValue => {
  try { return JSON.parse(raw) as JsonValue; } catch { return {}; }
};
