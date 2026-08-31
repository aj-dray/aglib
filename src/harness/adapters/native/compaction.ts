import type { Model, Message } from "../../../model/model.js";
import type { Stored } from "../../../session/entry.js";
import { collect } from "../../../model/model.js";
import { textOf } from "../../../content.js";

/**
 * Crude and deliberate: four characters per token, over the serialized request.
 * A real count needs the provider's tokenizer, which would mean shipping one
 * per provider to decide a threshold that is itself a guess. Being wrong here
 * costs one early or late compaction, not correctness.
 */
export function estimateTokens(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + JSON.stringify(message).length, 0) / 4;
}

/**
 * The latest position that can be folded without separating a tool call from
 * its results.
 *
 * Only two entry types are clean boundaries: a finished run, and an assistant
 * turn that asked for nothing. Cutting anywhere else can leave one call of a
 * batch summarized and its sibling live, which shows the model a result for a
 * call it can no longer see.
 */
/** How much of the tail is kept verbatim. A constant until a caller disagrees. */
const KEEP_FRACTION = 0.4;

export function compactionCut(entries: readonly Stored[]): number | undefined {
  const boundary = Math.floor(entries.length * (1 - KEEP_FRACTION));
  let cut: number | undefined;
  for (const entry of entries.slice(0, boundary)) {
    if (entry.type === "run.finished") cut = entry.seq;
    if (entry.type === "assistant" && !entry.calls?.length) cut = entry.seq;
  }
  return cut;
}

/** What the summary must preserve. Overridable, because what matters is domain-specific. */
function summaryPrompt(messages: readonly Message[]): string {
  return [
    "You are compacting an agent conversation that continues after this summary.",
    "Summarize the transcript below faithfully and concisely, covering:",
    "- Intent: the goal and the current state of the task",
    "- Decisions: choices made so far and why",
    "- Artifacts: files, outputs and results worth remembering (exact names, paths, values)",
    "- Pending: unfinished work, next steps, open questions",
    "",
    messages.map((message) => `${message.role}: ${textOf(message.content)}`).join("\n\n"),
  ].join("\n");
}

export async function summarize(input: {
  model: Model;
  messages: readonly Message[];
  prompt?: (messages: readonly Message[]) => string;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const outcome = await collect(input.model.generate({
    messages: [{ role: "user", content: (input.prompt ?? summaryPrompt)(input.messages) }],
    maxOutputTokens: 2_000,
    ...(input.signal ? { signal: input.signal } : {}),
  }));
  return outcome.ok ? textOf(outcome.value.message.content) : undefined;
}
