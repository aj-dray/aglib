import { test } from "bun:test";
import { defineModelConformance, type Answering, type ModelScript, type ModelUnderTest, type SentRequest } from "./conformance.js";
import { createAnthropicModel } from "./adapters/anthropic/index.js";
import { createOpenAiCompatibleModel } from "./adapters/openai-compatible/index.js";
import { createFakeModel, type FakeResponse } from "./adapters/fake/index.js";
import type { Model, ToolCall } from "./model.js";
import type { JsonValue } from "../json.js";

/**
 * The three implementations, held to one contract.
 *
 * Each subject renders the suite's scripts onto what it actually speaks and —
 * where there is a wire — reads the outgoing request back out of it. That
 * translation is the subject's, deliberately: it is the only place a provider's
 * field names may appear, and keeping it here is what lets the cases say what
 * the port means without naming a wire.
 */

/** A `fetch` faithful about the signal, because two cases turn on it. */
const abandoned = (): DOMException => new DOMException("This operation was aborted", "AbortError");

/**
 * A body that delivers one frame per read, so a caller can act between them —
 * a stream handed over whole cannot be cancelled part way through.
 */
function sse(frames: readonly unknown[], cut: boolean, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let at = 0;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => {
        try { controller.error(abandoned()); } catch { /* the body had already finished */ }
      });
    },
    pull(controller) {
      const frame = frames[at];
      at += 1;
      if (frame !== undefined) {
        controller.enqueue(encoder.encode(`data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`));
        return;
      }
      if (cut) controller.error(new Error("connection reset"));
      else controller.close();
    },
  });
}

/** A subject over an HTTP wire: script the body, keep the request, report it back. */
function scripted(wire: {
  frames(script: ModelScript): readonly unknown[];
  build(call: typeof fetch): Model;
  report(body: string): SentRequest;
}): (script: ModelScript) => Answering {
  return (script) => {
    let seen: string | undefined;
    const call = (async (_url: string, init: RequestInit) => {
      seen = String(init.body);
      const signal = init.signal ?? undefined;
      // What `fetch` does: a request already given up on never leaves. Without
      // it, an adapter that forgot to forward the signal would pass.
      if (signal?.aborted) throw abandoned();
      if (script.kind === "status") {
        return new Response(script.body, { status: script.status, statusText: "Scripted" });
      }
      return new Response(sse(wire.frames(script), script.kind === "cut", signal ?? undefined), { status: 200 });
    }) as unknown as typeof fetch;

    return {
      model: wire.build(call),
      sent: () => {
        if (seen === undefined) throw new Error("nothing was sent");
        return wire.report(seen);
      },
    };
  };
}

/** Arguments as a provider streams them: in pieces, and never for a call with none. */
const fragments = (args: string): readonly string[] =>
  args === "{}" ? [] : [args.slice(0, Math.ceil(args.length / 2)), args.slice(Math.ceil(args.length / 2))];

const unplayable = (script: ModelScript, who: string): never => {
  throw new Error(`${who} declares it cannot play '${script.kind}'`);
};

// ---- The fake -------------------------------------------------------------

function fakeResponse(script: ModelScript): FakeResponse {
  switch (script.kind) {
    case "text": return { text: script.deltas.join("") };
    case "tool-calls": return { calls: script.calls };
    case "truncated": return { text: script.text, ...(script.calls ? { calls: script.calls } : {}), finishReason: "length" };
    case "refused": return { finishReason: "refusal" };
    case "usage": return { usage: script.usage, model: script.model };
    case "silent": return { text: "ok" };
    default: return unplayable(script, "the fake");
  }
}

// ---- The Anthropic wire ---------------------------------------------------

const anthropicStart = (message: Record<string, unknown> = {}) => ({ type: "message_start", message });
const anthropicText = (text: string) => ({ type: "content_block_delta", delta: { type: "text_delta", text } });
const anthropicStop = (reason: string, usage?: Record<string, number>) =>
  ({ type: "message_delta", delta: { stop_reason: reason }, ...(usage ? { usage } : {}) });

const anthropicCalls = (calls: readonly ToolCall[]): readonly unknown[] => calls.flatMap((call) => [
  { type: "content_block_start", content_block: { type: "tool_use", id: call.callId, name: call.name } },
  ...fragments(call.arguments).map((partial_json) =>
    ({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json } })),
  { type: "content_block_stop" },
]);

function anthropicFrames(script: ModelScript): readonly unknown[] {
  switch (script.kind) {
    case "text":
      return [anthropicStart(), ...script.deltas.map(anthropicText), anthropicStop("end_turn")];
    case "reasoning":
      return [
        anthropicStart(),
        ...script.thoughts.map((thinking) => ({ type: "content_block_delta", delta: { type: "thinking_delta", thinking } })),
        anthropicText(script.text),
        anthropicStop("end_turn"),
      ];
    case "tool-calls":
      return [anthropicStart(), ...anthropicCalls(script.calls), anthropicStop("tool_use")];
    case "truncated":
      return [
        anthropicStart(), anthropicText(script.text), ...anthropicCalls(script.calls ?? []),
        anthropicStop("max_tokens"),
      ];
    case "refused":
      return [anthropicStart(), anthropicStop("refusal")];
    case "usage":
      return [
        anthropicStart({
          model: script.model,
          usage: {
            ...(script.usage.inputTokens !== undefined ? { input_tokens: script.usage.inputTokens } : {}),
            ...(script.usage.cacheReadTokens !== undefined ? { cache_read_input_tokens: script.usage.cacheReadTokens } : {}),
          },
        }),
        anthropicText("ok"),
        anthropicStop("end_turn", script.usage.outputTokens !== undefined ? { output_tokens: script.usage.outputTokens } : undefined),
      ];
    case "silent":
      return [anthropicStart(), anthropicText("ok"), anthropicStop("end_turn")];
    case "cut":
      return [anthropicStart(), anthropicText(script.text)];
    default:
      return unplayable(script, "the Anthropic wire");
  }
}

type AnthropicBlock = {
  type: string; text?: string; content?: string;
  tool_use_id?: string; id?: string; name?: string; input?: JsonValue;
  source?: { type?: string; media_type?: string };
};
type AnthropicBody = {
  max_tokens?: number; temperature?: number;
  system?: readonly { text: string }[];
  messages?: readonly { role: string; content?: readonly AnthropicBlock[] }[];
  tools?: readonly { name: string; input_schema: JsonValue }[];
  output_config?: { effort?: JsonValue };
};

function anthropicSent(raw: string): SentRequest {
  const body = JSON.parse(raw) as AnthropicBody;
  const text: string[] = [];
  const toolResults: { callId: string; content: string }[] = [];
  const toolCalls: ToolCall[] = [];
  const mediaTypes: string[] = [];

  for (const block of body.system ?? []) text.push(block.text);
  for (const message of body.messages ?? []) {
    for (const block of message.content ?? []) {
      if (block.type === "text") text.push(block.text ?? "");
      if (block.type === "tool_result") {
        text.push(block.content ?? "");
        toolResults.push({ callId: block.tool_use_id ?? "", content: block.content ?? "" });
      }
      if (block.type === "tool_use") {
        toolCalls.push({ callId: block.id ?? "", name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) });
      }
      if (block.type === "image") mediaTypes.push(block.source?.media_type ?? "");
    }
  }

  return {
    text, toolResults, toolCalls, mediaTypes,
    toolNames: (body.tools ?? []).map((tool) => tool.name),
    toolSchemas: Object.fromEntries((body.tools ?? []).map((tool) => [tool.name, tool.input_schema])),
    ...(body.max_tokens !== undefined ? { maxOutputTokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.output_config?.effort !== undefined ? { effort: body.output_config.effort } : {}),
    // Wherever it landed: a breakpoint may sit on the system prompt or on a
    // message block, and what the case asks is whether one was marked at all.
    cacheMarks: raw.match(/"cache_control"/g)?.length ?? 0,
  };
}

// ---- The OpenAI chat-completions wire -------------------------------------

const chatDelta = (delta: Record<string, unknown>) => ({ choices: [{ delta }] });
const chatFinish = (reason: string) => ({ choices: [{ finish_reason: reason, delta: {} }] });

const openAiCalls = (calls: readonly ToolCall[]): readonly unknown[] => calls.flatMap((call, index) => [
  chatDelta({ tool_calls: [{ index, id: call.callId, function: { name: call.name } }] }),
  ...fragments(call.arguments).map((args) => chatDelta({ tool_calls: [{ index, function: { arguments: args } }] })),
]);

function openAiFrames(script: ModelScript): readonly unknown[] {
  switch (script.kind) {
    case "text":
      return [...script.deltas.map((content) => chatDelta({ content })), chatFinish("stop"), "[DONE]"];
    case "reasoning":
      return [
        ...script.thoughts.map((reasoning) => chatDelta({ reasoning })),
        chatDelta({ content: script.text }), chatFinish("stop"), "[DONE]",
      ];
    case "tool-calls":
      return [...openAiCalls(script.calls), chatFinish("tool_calls"), "[DONE]"];
    case "truncated":
      return [
        chatDelta({ content: script.text }), ...openAiCalls(script.calls ?? []),
        chatFinish("length"), "[DONE]",
      ];
    case "refused":
      return [chatFinish("content_filter"), "[DONE]"];
    case "usage":
      return [
        { model: script.model, ...chatDelta({ content: "ok" }) },
        chatFinish("stop"),
        {
          model: script.model, choices: [],
          usage: {
            ...(script.usage.costUsd !== undefined ? { cost: script.usage.costUsd } : {}),
            // This wire counts the cached tokens inside `prompt_tokens`, so the
            // suite's disjoint counts are added back together to send. The
            // adapter has to recover the split, and the case compares what it
            // recovered against what was asked for.
            ...(script.usage.inputTokens !== undefined
              ? { prompt_tokens: script.usage.inputTokens + (script.usage.cacheReadTokens ?? 0) } : {}),
            ...(script.usage.outputTokens !== undefined ? { completion_tokens: script.usage.outputTokens } : {}),
            ...(script.usage.cacheReadTokens !== undefined
              ? { prompt_tokens_details: { cached_tokens: script.usage.cacheReadTokens } } : {}),
          },
        },
        "[DONE]",
      ];
    case "silent":
      return [chatDelta({ content: "ok" }), chatFinish("stop"), "[DONE]"];
    case "cut":
      return [chatDelta({ content: script.text })];
    default:
      return unplayable(script, "the OpenAI wire");
  }
}

type ChatPart = { type: string; text?: string; image_url?: { url: string } };
type ChatBody = {
  max_tokens?: number; temperature?: number;
  reasoning_effort?: JsonValue; reasoning?: { effort?: JsonValue };
  messages?: readonly {
    role: string; content?: string | null | readonly ChatPart[]; tool_call_id?: string;
    tool_calls?: readonly { id: string; function: { name: string; arguments: string } }[];
  }[];
  tools?: readonly { function: { name: string; parameters: JsonValue } }[];
};

/** The media type of an inline image, which this wire carries inside the URL. */
const dataMediaType = (url: string): string => /^data:([^;]+);base64,/.exec(url)?.[1] ?? url;

function openAiSent(raw: string): SentRequest {
  const body = JSON.parse(raw) as ChatBody;
  const text: string[] = [];
  const toolResults: { callId: string; content: string }[] = [];
  const toolCalls: ToolCall[] = [];
  const mediaTypes: string[] = [];

  for (const message of body.messages ?? []) {
    const content = message.content;
    if (message.role === "tool") {
      const said = typeof content === "string" ? content : "";
      text.push(said);
      toolResults.push({ callId: message.tool_call_id ?? "", content: said });
    } else if (typeof content === "string") {
      if (content) text.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") text.push(part.text ?? "");
        if (part.type === "image_url") mediaTypes.push(dataMediaType(part.image_url?.url ?? ""));
      }
    }
    for (const call of message.tool_calls ?? []) {
      toolCalls.push({ callId: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }

  const effort = body.reasoning_effort ?? body.reasoning?.effort;
  return {
    text, toolResults, toolCalls, mediaTypes,
    toolNames: (body.tools ?? []).map((tool) => tool.function.name),
    toolSchemas: Object.fromEntries((body.tools ?? []).map((tool) => [tool.function.name, tool.function.parameters])),
    ...(body.max_tokens !== undefined ? { maxOutputTokens: body.max_tokens } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(effort !== undefined ? { effort } : {}),
    // Nothing to mark: this wire caches by itself, and the port's boundary has
    // no field to land in.
    cacheMarks: 0,
  };
}

// ---- The three subjects ---------------------------------------------------

const subjects: readonly (readonly [string, ModelUnderTest])[] = [
  ["fake", {
    answering: (script) => ({ model: createFakeModel([fakeResponse(script)]) }),
    // It answers from what it was handed. No status to return, no body to cut,
    // no request to read back — and it says so rather than being assumed dumb.
    wire: "none",
    toolArguments: "whole",
    reasoning: "none",
    cost: "none",
  }],
  ["anthropic", {
    answering: scripted({
      frames: anthropicFrames,
      build: (call) => createAnthropicModel({ apiKey: "k", model: "claude-opus-5", fetch: call }),
      report: anthropicSent,
    }),
    // The current models reject sampling controls and take depth as an effort
    // level, so `temperature` is dropped here on purpose.
    wire: { effort: "sent", temperature: "ignored", cache: "sent" },
    toolArguments: "streamed",
    reasoning: "streamed",
    // The Messages wire carries counts and no charge.
    cost: "none",
  }],
  ["openai-compatible", {
    answering: scripted({
      frames: openAiFrames,
      build: (call) => createOpenAiCompatibleModel({
        apiKey: "k", baseUrl: "https://api.example.test/v1", model: "acme/one", fetch: call,
      }),
      report: openAiSent,
    }),
    // The mirror image: sampling controls are accepted, and caching is the
    // provider's own business with no breakpoint to send.
    wire: { effort: "sent", temperature: "sent", cache: "ignored" },
    toolArguments: "streamed",
    reasoning: "streamed",
    // `usage.cost` where the endpoint sends one — OpenRouter does, on every
    // response; plain OpenAI and the self-hosted endpoints on this wire do not,
    // and there it stays absent.
    cost: "reported",
  }],
];

for (const [name, subject] of subjects) {
  for (const item of defineModelConformance(subject)) test(`${name}: ${item.name}`, item.run);
}
