import type {
  ContentPart, Message, Model, ModelDelta, ModelError, ModelRequest, ModelResponse, ToolCall, ToolSpec, Usage,
} from "../../model.js";
import { err, ok, type Result } from "../../../result.js";
import { textOf } from "../../../content.js";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  version?: string;
  fetch?: typeof fetch;
}

/**
 * The Anthropic Messages wire.
 *
 * A genuinely different shape from OpenAI's — the leading system prompt hoisted
 * out of the message list, tool results carried as user content blocks, cache
 * breakpoints marked inline — which is the point of it being here: a port
 * proved against one wire format has not been proved.
 *
 * Three things this wire will refuse, and what we send instead:
 *
 * - **Thinking budgets.** `thinking: { type: "enabled", budget_tokens }` is
 *   removed on the current models and returns 400. Depth is `output_config.effort`
 *   over adaptive thinking, so `effort` maps there and nothing computes a budget.
 * - **Sampling controls.** `temperature`, `top_p` and `top_k` are removed on the
 *   same models. `ModelRequest.temperature` is therefore dropped here rather
 *   than forwarded into a request the provider rejects.
 * - **A system message in the middle of a turn.** Only the *leading* run of
 *   system messages becomes the `system` field. One arriving after the
 *   conversation has started is turn-scoped context, which the projection
 *   deliberately places after the cache boundary, so it stays in `messages` as
 *   a mid-conversation system message. Hoisting it would put the one thing that
 *   changes every turn at the front of the prefix that must not change.
 *   Supported on Opus 5, Opus 4.8 and Fable 5; a model without it fails the
 *   request rather than silently having its cache invalidated every turn.
 */
export function createAnthropicModel(options: AnthropicOptions): Model {
  const call = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1";

  return {
    id: `anthropic:${options.model}`,

    async *generate(request: ModelRequest): AsyncGenerator<ModelDelta, Result<ModelResponse, ModelError>> {
      // Only the leading run of system messages is the system prompt. Anything
      // after it belongs where the projection put it — see the header.
      let lead = 0;
      while (lead < request.messages.length && request.messages[lead]!.role === "system") lead += 1;
      const system = request.messages.slice(0, lead).map((message) => textOf(message.content));
      const conversation = request.messages.slice(lead);

      // The prefix ends where the caller says it does. In practice that is the
      // end of the system prompt, which is the one span fixed for the whole
      // run; a mark past it is honoured too rather than quietly ignored.
      const boundary = request.cacheAfter;
      const cacheSystem = boundary !== undefined && boundary >= lead && system.length > 0;
      const cacheAt = boundary !== undefined && boundary > lead ? boundary - lead - 1 : -1;

      const maxOutputTokens = request.maxOutputTokens ?? 32_000;

      let response: Response;
      try {
        response = await call(`${baseUrl}/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": options.version ?? "2023-06-01",
          },
          body: JSON.stringify({
            model: options.model,
            max_tokens: maxOutputTokens,
            ...(system.length ? { system: encodeSystem(system, cacheSystem) } : {}),
            messages: encodeConversation(conversation, cacheAt),
            ...(request.tools?.length ? { tools: request.tools.map(encodeTool) } : {}),
            ...(request.effort
              ? { thinking: { type: "adaptive" }, output_config: { effort: request.effort } }
              : {}),
            stream: true,
          }),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      } catch (error) {
        return err(transportError(error, request.signal));
      }
      if (!response.ok) return err(await httpError(response));
      if (!response.body) return err({ code: "provider", message: "No response body", retryable: true });

      const text: string[] = [];
      const calls: ToolCall[] = [];
      let partial = "";
      let stop: string | undefined;
      let usage: Usage = {};
      let model: string | undefined;

      // A stream that dies mid-body — cancelled, dropped, truncated — must come
      // back as a typed failure like any other. Without this the generator throws,
      // `run.result` rejects instead of resolving `cancelled`, no `run.finished`
      // is ever committed, and the activation stays open until its claim expires.
      try {
        for await (const event of sseData(response.body)) {
          let frame: AnthropicFrame;
          try { frame = JSON.parse(event) as AnthropicFrame; } catch { continue; }

          if (frame.type === "message_start" && frame.message) {
            model = frame.message.model;
            usage = { ...usage, ...decodeUsage(frame.message.usage) };
          }
          if (frame.type === "content_block_start" && frame.content_block?.type === "tool_use") {
            calls.push({ callId: frame.content_block.id!, name: frame.content_block.name!, arguments: "" });
            partial = "";
          }
          if (frame.type === "content_block_delta") {
            const delta = frame.delta!;
            if (delta.type === "text_delta" && delta.text) { text.push(delta.text); yield { type: "text.delta", text: delta.text }; }
            if (delta.type === "thinking_delta" && delta.thinking) yield { type: "reasoning.delta", text: delta.thinking };
            if (delta.type === "input_json_delta" && delta.partial_json !== undefined) {
              partial += delta.partial_json;
              const current = calls.at(-1);
              if (current) yield { type: "tool-call.delta", callId: current.callId, arguments: delta.partial_json };
            }
          }
          if (frame.type === "content_block_stop" && calls.length) {
            const current = calls.at(-1)!;
            if (!current.arguments) current.arguments = partial || "{}";
          }
          if (frame.type === "message_delta") {
            stop = frame.delta?.stop_reason ?? stop;
            usage = { ...usage, ...decodeUsage(frame.usage) };
          }
          if (frame.type === "error") {
            return err({ code: "provider", message: frame.error?.message ?? "Provider error", retryable: true });
          }
        }
      } catch (error) {
        return err(transportError(error, request.signal));
      }

      return ok({
        message: { content: text.join(""), ...(calls.length ? { calls } : {}) },
        finishReason: stop === "max_tokens" ? "length" : stop === "refusal" ? "refusal" : calls.length ? "tool-calls" : "stop",
        usage,
        ...(model ? { model } : {}),
      });
    },
  };
}

/**
 * Text blocks rather than one joined string, so the prefix can carry
 * breakpoints.
 *
 * Two are marked: the **first** block and the **last**. A breakpoint caches
 * everything before it, so the last one is what makes the whole prefix
 * reusable across a conversation's turns — and marking every block between
 * would buy nothing while spending a budget of four.
 *
 * The first earns its own for a different reason. The first block is an agent's
 * standing instructions, which are identical for every conversation it serves;
 * everything after it is composed per conversation and changes with it. With
 * one breakpoint at the end, a new conversation shares nothing: its prefix
 * differs from the last one somewhere in the middle, so the whole of it is
 * written again, instructions included. With one at the head, the instructions
 * are read from cache by every conversation and only what actually differs is
 * paid for — which is the common case for an agent serving many callers at
 * once, and free where there is only one.
 *
 * Skipped when there is a single block: the two marks would be the same one.
 */
function encodeSystem(blocks: readonly string[], cache: boolean): unknown[] {
  const marked = new Set(blocks.length > 1 ? [0, blocks.length - 1] : [blocks.length - 1]);
  return blocks.map((text, index) => ({
    type: "text",
    text,
    ...(cache && marked.has(index) ? { cache_control: { type: "ephemeral" } } : {}),
  }));
}

/**
 * Tool results are user-role content blocks here, not a role of their own.
 *
 * `cacheAt` is an index into `messages`; the breakpoint lands on the last
 * content block that message produced. Tool results merge into a preceding user
 * block, so the mapping from message to block is not one to one and the mark is
 * placed as each message is encoded rather than computed afterwards.
 */
function encodeConversation(messages: readonly Message[], cacheAt = -1): unknown[] {
  const out: { role: string; content: unknown[] }[] = [];
  let mark: unknown[] | undefined;

  messages.forEach((message, index) => {
    if (message.role === "tool") {
      const block = {
        type: "tool_result", tool_use_id: message.callId, content: typeof message.content === "string" ? message.content : encodeContent(message.content),
        ...(message.isError ? { is_error: true } : {}),
      };
      const last = out.at(-1);
      if (last?.role === "user") last.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else if (message.role === "assistant") {
      const content: unknown[] = [];
      const spoken = textOf(message.content);
      if (spoken) content.push({ type: "text", text: spoken });
      for (const call of message.calls ?? []) {
        content.push({ type: "tool_use", id: call.callId, name: call.name, input: safeJson(call.arguments) });
      }
      out.push({ role: "assistant", content });
    } else if (message.role === "system") {
      // Turn-scoped context, kept where the projection put it: an operator
      // instruction inside the conversation leaves the cached prefix intact,
      // where rewriting the front of it would invalidate every following turn.
      out.push({ role: "system", content: encodeContent(message.content) });
    } else {
      out.push({ role: "user", content: encodeContent(message.content) });
    }
    if (index === cacheAt) mark = out.at(-1)?.content;
  });

  const block = mark?.at(-1) as Record<string, unknown> | undefined;
  if (block) block["cache_control"] = { type: "ephemeral" };
  return out;
}

function encodeContent(content: Message["content"]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const parts: unknown[] = [];
  for (const part of content as readonly ContentPart[]) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    if (part.type === "image") {
      parts.push(part.source.kind === "url"
        ? { type: "image", source: { type: "url", url: part.source.url } }
        : { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.source.data } });
    }
  }
  return parts;
}

const encodeTool = (tool: ToolSpec) => ({
  name: tool.name, description: tool.description, input_schema: tool.parameters,
});

const safeJson = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return {}; } };

const decodeUsage = (usage: AnthropicUsage | undefined): Usage => usage ? {
  ...(usage.input_tokens !== undefined ? { inputTokens: usage.input_tokens } : {}),
  ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
  ...(usage.cache_read_input_tokens !== undefined ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
  ...(usage.cache_creation_input_tokens !== undefined ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
} : {};

async function httpError(response: Response): Promise<ModelError> {
  const body = await response.text().catch(() => "");
  const code: ModelError["code"] =
    response.status === 401 || response.status === 403 ? "auth"
    : response.status === 429 ? "rate-limit"
    : response.status === 400 && /prompt is too long|context/i.test(body) ? "context-length"
    : response.status >= 500 ? "provider"
    : "failed";
  return {
    code,
    message: `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 400)}` : ""}`,
    retryable: code === "rate-limit" || code === "provider",
  };
}

function transportError(error: unknown, signal?: AbortSignal): ModelError {
  if (signal?.aborted) return { code: "cancelled", message: "Generation cancelled", retryable: false };
  return { code: "provider", message: error instanceof Error ? error.message : String(error), retryable: true };
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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

interface AnthropicUsage {
  input_tokens?: number; output_tokens?: number;
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
}
interface AnthropicFrame {
  type: string;
  message?: { model?: string; usage?: AnthropicUsage };
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: AnthropicUsage;
  error?: { message?: string };
}
