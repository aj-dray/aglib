/**
 * The log, projected into the messages a Thread renders.
 *
 * The log is the session's state, not a record of it, so this is a projection
 * and never a second transcript: every message is derived from entries and
 * keyed by the `seq` that produced it.
 */
import type { ThreadMessageLike } from "@assistant-ui/react";
import { textOf, type Failure, type Stored, type ToolResult } from "./api";

/** What a run.finished entry says, carried on the message it becomes. */
export interface Ending {
  outcome: "completed" | "failed" | "cancelled";
  error?: Failure;
}

export interface Generation {
  model?: string;
  startedAt: string;
  endedAt: string;
  /**
   * Whether this turn was answered by a different model from the one before it.
   *
   * Naming the model on every turn says the same thing over and over; the fact
   * worth reading is that it changed, which happens when the session is
   * retuned mid-conversation.
   */
  changed?: boolean;
}

/** Everything this interface adds to a message beyond its parts. */
export interface Custom {
  /** The session that sent this input, when an agent did. */
  from?: string;
  generation?: Generation;
  ending?: Ending;
}

export const customOf = (metadata: { custom?: Record<string, unknown> } | undefined): Custom =>
  (metadata?.custom ?? {}) as Custom;

const resultText = (result: ToolResult): string => textOf(result.content);

export function project(entries: readonly Stored[]): ThreadMessageLike[] {
  // A call and its result are two entries; the Thread shows them as one part.
  const results = new Map<string, ToolResult>();
  const called = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "tool.finished") results.set(entry.callId, entry.result);
    if (entry.type === "assistant") for (const call of entry.calls ?? []) called.add(call.callId);
  }

  const named = (generation: Generation): Generation => {
    const changed = generation.model !== undefined && generation.model !== answering;
    answering = generation.model ?? answering;
    return { ...generation, ...(changed ? { changed: true } : {}) };
  };

  const messages: ThreadMessageLike[] = [];
  // Which model answered last, so a turn only names one when it is a new one.
  let answering: string | undefined;
  for (const entry of entries) {
    if (entry.type === "run.started") {
      messages.push({
        role: "user",
        id: String(entry.seq),
        createdAt: new Date(entry.at),
        content: [{ type: "text", text: textOf(entry.input) }],
        ...(entry.from ? { metadata: { custom: { from: entry.from } satisfies Custom } } : {}),
      });
      continue;
    }

    if (entry.type === "assistant") {
      const text = textOf(entry.content);
      const calls = entry.calls ?? [];
      if (!text && calls.length === 0) continue;
      messages.push({
        role: "assistant",
        id: String(entry.seq),
        createdAt: new Date(entry.at),
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...calls.map((call) => {
            const result = results.get(call.callId);
            // `argsText` is what the provider actually sent. A parsed `args`
            // beside it would be a second field holding the same value.
            return {
              type: "tool-call" as const,
              toolCallId: call.callId,
              toolName: call.name,
              argsText: call.arguments,
              ...(result ? { result: resultText(result), isError: result.isError === true } : {}),
            };
          }),
        ],
        ...(entry.generation ? { metadata: { custom: { generation: named(entry.generation) } } } : {}),
      });
      continue;
    }

    if (entry.type === "run.finished") {
      messages.push({
        role: "system",
        id: String(entry.seq),
        createdAt: new Date(entry.at),
        content: [{ type: "text", text: entry.outcome }],
        metadata: {
          custom: {
            ending: { outcome: entry.outcome, ...(entry.error ? { error: entry.error } : {}) },
          } satisfies Custom,
        },
      });
      continue;
    }

    // A result whose call is not in view — the log this read began from started
    // after it — is still shown in place, because dropping it would hide work
    // the session actually did.
    if (entry.type === "tool.finished" && !called.has(entry.callId)) {
      messages.push({
        role: "assistant",
        id: String(entry.seq),
        createdAt: new Date(entry.at),
        content: [
          {
            type: "tool-call",
            toolCallId: entry.callId,
            toolName: entry.callId,
            argsText: "",
            result: resultText(entry.result),
            isError: entry.result.isError === true,
          },
        ],
      });
    }

    // tool.started is bookkeeping the assistant entry above it already holds,
    // and a summary is compaction output the log keeps but nobody reads here.
  }

  return messages;
}
