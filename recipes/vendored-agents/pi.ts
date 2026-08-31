/**
 * Pi as a `Harness`, on its agent library rather than the protocol.
 *
 * The other half of the argument this recipe makes. `harnesses.ts` in the old
 * service listed Pi as an ACP row and marked it unavailable, which was true of
 * the protocol route and hid the fact that Pi ships a library. It does, and the
 * library gives back everything the protocol takes away:
 *
 *   - `state.systemPrompt` is ours to set. ACP has no such field.
 *   - `state.tools` is ours to fill, so the agent's hands are the ones we
 *     handed it and its calls run through code we wrote.
 *   - `state.messages` is ours to seed, so an activation starts from the log
 *     rather than from whatever the agent remembers. That is what makes this
 *     the only vendor harness here that can honestly claim `recovery`.
 *
 * Its model is a descriptor — an id, a wire and a base URL — not a client, so
 * pointing it at `serveAnthropicWire` is three fields. Pi's loop then runs on
 * whatever `Model` is behind the port, and never learns that it did.
 */
import { Agent } from "@earendil-works/pi-agent-core";
// The stream function is pi's own: it speaks the wire the descriptor names.
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Harness, HarnessContext, HarnessResult } from "aglib/harness";
import type { Entry, ToolCall } from "aglib/session";
import { textOf } from "aglib";
import type { ToolExecutor } from "aglib";

export interface PiOptions {
  /** Where its requests go. This is `serveAnthropicWire`, so any model answers. */
  baseUrl: string;
  token: string;
  /** What Pi calls the model. An observation for its own logs; the bridge ignores it. */
  model?: string;
  effort?: "low" | "medium" | "high";
  contextWindow?: number;
  maxTokens?: number;
}

export function createPiHarness(options: PiOptions): Harness {
  return {
    id: "pi",
    // Its transcript is assigned from the log at the start of every activation,
    // so an interrupted run is continued rather than begun again.
    recovery: "history",
    run: (context) => runTurn(options, context),
  };
}

async function runTurn(options: PiOptions, context: HarnessContext): Promise<HarnessResult> {
  const executor = context.tools;
  const agent = new Agent({
    streamFn: streamSimple,
    // A descriptor, not a client. `anthropic-messages` is the wire our bridge
    // speaks, and the base URL is where it is listening.
    initialState: {
      systemPrompt: textOf(context.instructions),
      model: {
        id: options.model ?? "claude-sonnet-5",
        name: options.model ?? "claude-sonnet-5",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: options.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: options.contextWindow ?? 200_000,
        maxTokens: options.maxTokens ?? 8_192,
      } as never,
      thinkingLevel: options.effort ?? "low",
      tools: toolsFor(executor, context) as never,
      messages: transcriptFor(context) as never,
    },
    getApiKey: () => options.token,
  });

  let failure: string | undefined;
  const stop = () => { agent.abort(); };
  context.signal.addEventListener("abort", stop, { once: true });

  // Pi reports what it did; the log records it. Only `message_end` and the tool
  // events are committed, because those are the two things that happened —
  // updates are for a viewer and are emitted, never stored.
  const unsubscribe = agent.subscribe(async (event) => {
    if (event.type === "message_update") {
      const said = deltaOf(event.assistantMessageEvent);
      if (said) context.emit({ type: "text.delta", text: said });
      return;
    }
    if (event.type === "message_end") {
      // Pi ends *every* message, the user's included — and the user's is
      // already an entry, committed by `runAgent` before this harness was
      // called. Recording it again put the question in the log a second time,
      // wearing the assistant's role, and made one exchange read as two turns.
      if ((event.message as { role?: string }).role !== "assistant") return;
      const entry = assistantEntry(event.message, context);
      if (entry) await context.commit([entry]);
      return;
    }
    if (event.type === "tool_execution_start") {
      await context.commit([{ type: "tool.started", runId: context.runId, callId: event.toolCallId }]);
      return;
    }
    if (event.type === "tool_execution_end") {
      await context.commit([{
        type: "tool.finished", runId: context.runId, callId: event.toolCallId,
        result: { content: textFrom(event.result), ...(event.isError ? { isError: true } : {}) },
      }]);
    }
  });

  try {
    await agent.prompt(inputFor(context));
    await agent.waitForIdle();
  } catch (error) {
    if (context.signal.aborted) return { status: "cancelled" };
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    unsubscribe();
    context.signal.removeEventListener("abort", stop);
  }

  if (context.signal.aborted) return { status: "cancelled" };
  if (failure) return { status: "failed", error: { code: "failed", message: failure, retryable: true } };

  const last = agent.state.messages.filter((message) => message.role === "assistant").at(-1);
  return { status: "completed", output: last ? textFrom(last) : "" };
}

/**
 * Our tools, in its vocabulary.
 *
 * `ToolSpec.parameters` is already JSON Schema, which is what a TypeBox schema
 * is at runtime, so nothing is converted — the same schema the model is shown
 * is the one the executor validates against.
 */
function toolsFor(executor: ToolExecutor | undefined, context: HarnessContext): unknown[] {
  if (!executor) return [];
  return executor.list().map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (toolCallId: string, params: unknown) => {
      const call: ToolCall = { callId: toolCallId, name: spec.name, arguments: JSON.stringify(params ?? {}) };
      const answered = await executor.execute({ calls: [call], signal: context.signal });
      const result = answered.results[0]?.result;
      return {
        content: [{ type: "text", text: result ? textOf(result.content) : "" }],
        details: result?.details ?? null,
        ...(result?.isError ? { isError: true } : {}),
      };
    },
  }));
}

/** The committed log, as its transcript. This is the whole of `recovery`. */
function transcriptFor(context: HarnessContext): unknown[] {
  const out: unknown[] = [];
  for (const message of context.history()) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      out.push({
        role: "toolResult", toolCallId: message.callId,
        content: [{ type: "text", text: textOf(message.content) }],
        isError: message.isError ?? false,
      });
      continue;
    }
    const text = textOf(message.content);
    const calls = message.role === "assistant" ? (message.calls ?? []) : [];
    if (!text && !calls.length) continue;
    out.push({
      role: message.role,
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...calls.map((call) => ({
          type: "toolCall", id: call.callId, name: call.name,
          arguments: safeJson(call.arguments),
        })),
      ],
    });
  }
  return out;
}

function assistantEntry(message: unknown, context: HarnessContext): Entry | undefined {
  const said = textFrom(message);
  const calls = callsFrom(message);
  if (!said && !calls.length) return undefined;
  return {
    type: "assistant", runId: context.runId, content: said,
    ...(calls.length ? { calls } : {}),
  };
}

interface PiContent { type?: string; text?: string; id?: string; name?: string; arguments?: unknown }

const partsOf = (message: unknown): readonly PiContent[] => {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content as PiContent[] : [];
};

const textFrom = (message: unknown): string =>
  partsOf(message).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");

const callsFrom = (message: unknown): ToolCall[] =>
  partsOf(message)
    .filter((part) => part.type === "toolCall")
    .map((part) => ({
      callId: String(part.id ?? ""), name: String(part.name ?? ""),
      arguments: JSON.stringify(part.arguments ?? {}),
    }));

const deltaOf = (event: unknown): string => {
  const shape = event as { type?: string; delta?: { text?: string }; text?: string };
  if (shape.delta?.text) return shape.delta.text;
  return "";
};

const safeJson = (raw: string): unknown => { try { return JSON.parse(raw); } catch { return {}; } };

/** This activation's input: the entries `runAgent` committed before calling us. */
const inputFor = (context: HarnessContext): string =>
  context.entries()
    .filter((entry) => entry.type === "run.started" && entry.runId === context.runId)
    .map((entry) => textOf((entry as Extract<Entry, { type: "run.started" }>).input))
    .join("\n\n");
