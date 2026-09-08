import type {
  ContentPart, Message, Model, ModelDelta, ModelError, ModelRequest, ModelResponse, ToolCall, ToolSpec, Usage,
} from "../../model.js";
import { err, ok, type Result } from "../../../result.js";
import { textOf } from "../../../content.js";

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
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * The OpenAI chat-completions wire, which almost every provider now speaks —
 * OpenRouter, Together, Groq, vLLM, Ollama. One adapter, one base URL.
 */
export function createOpenAiCompatibleModel(options: OpenAiCompatibleOptions): Model {
  const call = options.fetch ?? fetch;
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
            messages: request.messages.map(encodeMessage),
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

      if (!response.ok) return err(await httpError(response));
      if (!response.body) return err({ code: "provider", message: "No response body", retryable: true });

      const text: string[] = [];
      const calls = new Map<number, { callId: string; name: string; arguments: string }>();
      let finish: ModelResponse["finishReason"] = "stop";
      let usage: Usage = {};
      let model: string | undefined;

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

          const reasoning = choice.delta?.reasoning;
          if (reasoning) yield { type: "reasoning.delta", text: reasoning };

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

      return ok({
        message: { content: text.join(""), ...(collected.length ? { calls: collected } : {}) },
        finishReason: collected.length && finish === "stop" ? "tool-calls" : finish,
        usage,
        ...(model ? { model } : {}),
      });
    },
  };
}

/** OpenRouter is this wire with a fixed base URL and attribution headers. */
export function createOpenRouterModel(input: {
  apiKey: string; model: string; appUrl?: string; appName?: string; fetch?: typeof fetch;
}): Model {
  return createOpenAiCompatibleModel({
    apiKey: input.apiKey,
    baseUrl: "https://openrouter.ai/api/v1",
    model: input.model,
    effortParameter: "reasoning",
    headers: {
      ...(input.appUrl ? { "http-referer": input.appUrl } : {}),
      ...(input.appName ? { "x-title": input.appName } : {}),
    },
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
}

function encodeEffort(
  effort: ModelRequest["effort"],
  parameter: "reasoning_effort" | "reasoning" | "none",
): Record<string, unknown> {
  if (!effort || parameter === "none") return {};
  return parameter === "reasoning" ? { reasoning: { effort } } : { reasoning_effort: effort };
}

function encodeMessage(message: Message): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.callId, content: textOf(message.content) };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: textOf(message.content) || null,
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
  // `prompt_tokens` is the whole prompt and `cached_tokens` is counted inside
  // it — "cached tokens present in the prompt". `Usage` keeps the three input
  // counts disjoint, so the cached part comes out here rather than every
  // caller having to know which wire produced the number it is holding.
  ...(usage.prompt_tokens !== undefined
    ? { inputTokens: Math.max(usage.prompt_tokens - (usage.prompt_tokens_details?.cached_tokens ?? 0), 0) } : {}),
  ...(usage.completion_tokens !== undefined ? { outputTokens: usage.completion_tokens } : {}),
  ...(usage.prompt_tokens_details?.cached_tokens !== undefined
    ? { cacheReadTokens: usage.prompt_tokens_details.cached_tokens } : {}),
});

async function httpError(response: Response): Promise<ModelError> {
  const body = await response.text().catch(() => "");
  const code: ModelError["code"] =
    response.status === 401 || response.status === 403 ? "auth"
    : response.status === 429 ? "rate-limit"
    : response.status === 400 && /context|token/i.test(body) ? "context-length"
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
  prompt_tokens_details?: { cached_tokens?: number };
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
      tool_calls?: readonly { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}
