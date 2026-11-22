import type { HarnessContext } from "../harness.js";
import type { Content, ContentPart } from "../../content.js";
import { textOf } from "../../content.js";
import type { Delivery, Entry, Stored, ToolCall, ToolResult, Usage } from "../../session/entry.js";
import type { Message } from "../../session/messages.js";
import type { JsonValue } from "../../json.js";

/**
 * What a vendor-loop harness shares: an agent process that owns its own
 * context and model calls, running *our* tools and nothing of its own.
 *
 * Two facts hold for every such adapter and are why this file exists rather
 * than two copies of it. The vendor's conversation lives in the vendor's own
 * session store, so continuing it means naming that session; and our log has
 * to say what happened in a shape a native model could take over from, because
 * an owner who switches an instance from a subscription to an API key expects
 * the conversation to carry on.
 */

/**
 * The vendor session a run continues, recorded on the run's final assistant
 * entry. `fingerprint` names what the session was opened with that cannot be
 * changed on resume — a vendor that fixes the tool list at session start is
 * resumed only while the list is the same.
 */
export function sessionState(provider: string, session: string, fingerprint?: string) {
  return { provider, items: [{ session, ...(fingerprint ? { fingerprint } : {}) }] as JsonValue[] };
}

/** A stable name for a tool list, by what the model is shown of it. */
export function toolFingerprint(context: HarnessContext): string {
  const text = JSON.stringify((context.tools?.list() ?? []).map((tool) => [tool.name, tool.description, tool.parameters]));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
  return hash.toString(16);
}

/**
 * Where this activation starts: the vendor session to resume, and the words to
 * open it with.
 *
 * A session is resumed only when the latest assistant entry in the log was
 * written by this provider and names it. Any later assistant entry means
 * another model spoke since, so the vendor's copy is missing part of the
 * conversation and resuming it would answer from a past that is not the log's.
 * Then the session starts fresh, opened with the conversation so far rendered
 * as text: the vendor cannot be handed our messages as its own, and a summary
 * of them is the honest substitute. `fresh` asks for that start whatever the
 * log says, for a session the log names and the vendor no longer has; a
 * `fingerprint` that differs from the recorded one asks for it too.
 */
export function opening(context: HarnessContext, provider: string, options: { fresh?: boolean; fingerprint?: string } = {}): { resume?: string; prompt: Content } {
  const entries = context.entries();
  const last = entries.findLast((entry) => entry.type === "assistant");
  const state = !options.fresh && last?.type === "assistant" && last.providerState?.provider === provider ? last.providerState.items[0] : undefined;
  const fields = state && typeof state === "object" && !Array.isArray(state) ? state as { readonly [key: string]: JsonValue } : {};
  const session = typeof fields["session"] === "string" && fields["fingerprint"] === options.fingerprint ? fields["session"] : undefined;
  const turn = context.context?.turn ? [`<turn-context>\n${context.context.turn}\n</turn-context>`] : [];
  if (session) {
    const since = entries.filter((entry): entry is Stored<Extract<Entry, { type: "run.started" | "hook.input" }>> =>
      (entry.type === "run.started" || entry.type === "hook.input") && entry.seq > last!.seq);
    return { resume: session, prompt: join([...turn, ...since.map((entry) => entry.input)]) };
  }
  const current = entries.filter((entry) => entry.type === "run.started" && entry.runId === context.runId);
  const before = earlier(context.history(), current.length);
  const transcript = before.length ? [`<conversation-so-far>\n${transcriptText(before)}\n</conversation-so-far>`] : [];
  return { prompt: join([...transcript, ...turn, ...current.map((entry) => (entry as Extract<Entry, { type: "run.started" }>).input)]) };
}

/** Inputs folded into this run by `drain` that the vendor has not been shown yet. */
export function arrivals(context: HarnessContext, shown: Set<number>): Content[] {
  return context.entries()
    .filter((entry) => entry.type === "run.started" && entry.runId === context.runId && !shown.has(entry.seq))
    .map((entry) => { shown.add(entry.seq); return (entry as Extract<Entry, { type: "run.started" }>).input; });
}

/** Seqs of this run's inputs that `opening` already put in the prompt. */
export function openingInputs(context: HarnessContext): Set<number> {
  return new Set(context.entries().filter((entry) => entry.type === "run.started" && entry.runId === context.runId).map((entry) => entry.seq));
}

/**
 * The conversation before this run, as the model was shown it: the projection
 * minus its system messages (the vendor gets ours as its own instructions) and
 * minus the inputs this run is about to send.
 */
function earlier(messages: readonly Message[], current: number): Message[] {
  const body = messages.filter((message) => message.role !== "system");
  let drop = current;
  const out = [...body];
  while (drop > 0 && out.length && out[out.length - 1]!.role === "user") { out.pop(); drop -= 1; }
  return out;
}

const RESULT_CHARS = 4_000;

/** A readable transcript. Tool output is cut, because the next turns can read again what matters. */
export function transcriptText(messages: readonly Message[]): string {
  return messages.map((message) => {
    if (message.role === "user") return `[user]\n${described(message.content)}`;
    if (message.role === "assistant") {
      const calls = (message.calls ?? []).map((call) => `→ ${call.name}(${call.arguments})`);
      return [`[assistant]`, textOf(message.content), ...calls].filter(Boolean).join("\n");
    }
    if (message.role === "tool") {
      const text = described(message.content);
      return `[tool result${message.isError ? ", error" : ""}]\n${text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}…` : text}`;
    }
    return "";
  }).filter(Boolean).join("\n\n");
}

/** Text, with media named rather than dropped silently. */
export function described(content: Content): string {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "image") return `[image ${part.mediaType}]`;
    if (part.type === "file") return `[file ${part.name ?? ""} ${part.mediaType}]`.replace("  ", " ");
    return "";
  }).filter(Boolean).join("\n");
}

function join(parts: readonly Content[]): Content {
  const out: ContentPart[] = [];
  for (const part of parts) {
    if (typeof part === "string") { if (part) out.push({ type: "text", text: part }); }
    else out.push(...part);
  }
  return out.every((part) => part.type === "text") ? out.map((part) => (part as { text: string }).text).join("\n\n") : out;
}

/**
 * Runs our tools for a vendor's loop, one call at a time, through the log.
 *
 * Each call is committed the way the native loop commits one — the assistant
 * turn that asked for it with the text said before it, then `tool.started`,
 * then `tool.finished` with the call's deliveries — so the log projects to a
 * conversation any model can continue. Calls are serialised: a vendor may run
 * several at once, and interleaving their entries would leave an assistant turn
 * whose calls are answered out of order.
 */
export function createToolRunner(context: HarnessContext) {
  let said = "";
  let tail: Promise<unknown> = Promise.resolve();
  let usage: Usage | undefined;
  return {
    /** A block of text the vendor said, since the last call or the start. */
    say(text: string) { if (text) said = said ? `${said}\n\n${text}` : text; },
    /** Usage to carry on the next committed assistant entry. */
    spent(next: Usage) { usage = addUsage(usage, next); },
    /**
     * A call the vendor made through one of its own account connectors, which
     * ran in the vendor's cloud rather than through our executor. It is
     * recorded as a note — what was said before it, then the call and what it
     * returned — not as a tool call, because a model that takes the session
     * over has no such tool, and a provider may refuse a history that calls a
     * tool the request does not declare.
     */
    note(call: { name: string; arguments: unknown; result: string; isError?: boolean }) {
      const record = `[connector ${call.name}] ${JSON.stringify(call.arguments ?? {})}\n${call.isError ? "failed: " : "→ "}${call.result.length > RESULT_CHARS ? `${call.result.slice(0, RESULT_CHARS)}…` : call.result}`;
      const next = tail.then(async () => {
        const text = said;
        said = "";
        await context.commit([{ type: "assistant", runId: context.runId, content: text ? `${text}\n\n${record}` : record }]);
      });
      tail = next.catch(() => undefined);
      return next;
    },
    run(call: ToolCall): Promise<ToolResult> {
      const next = tail.then(() => runOne(call));
      tail = next.catch(() => undefined);
      return next;
    },
    /** The final assistant entry: what was said after the last call, and where the vendor's session is. */
    async finish(providerState: { provider: string; items: JsonValue[] }, generation: { id: string; model?: string; startedAt: string }) {
      await tail;
      const text = said;
      said = "";
      const spentHere = usage;
      usage = undefined;
      await context.commit([{
        type: "assistant", runId: context.runId, content: text,
        ...(spentHere ? { usage: spentHere } : {}), providerState,
        generation: { ...generation, endedAt: new Date().toISOString(), ...(context.context?.turn ? { turn: context.context.turn } : {}) },
      }]);
      return text;
    },
  };

  async function runOne(call: ToolCall): Promise<ToolResult> {
    const text = said;
    said = "";
    const spentHere = usage;
    usage = undefined;
    await context.commit([
      { type: "assistant", runId: context.runId, content: text, calls: [call], ...(spentHere ? { usage: spentHere } : {}) },
      { type: "tool.started", runId: context.runId, callId: call.callId },
    ]);
    let completion: { result: ToolResult; deliveries: readonly Delivery[] } | undefined;
    if (context.tools) {
      for await (const done of context.tools.execute({ calls: [call], signal: context.signal })) { completion = done; break; }
    }
    const result = completion?.result ?? { content: context.tools ? "Tool use cancelled" : `No tool named '${call.name}' is available.`, isError: true };
    await context.commit([{ type: "tool.finished", runId: context.runId, callId: call.callId, result }], completion?.deliveries ?? []);
    return result;
  }
}

export function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return { ...b };
  const out: Usage = { ...a };
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"] as const) {
    if (b[key] !== undefined) out[key] = (out[key] ?? 0) + b[key];
  }
  return out;
}
