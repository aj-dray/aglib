import type { Content } from "../content.js";
import type { From, Stored, ToolCall } from "./entry.js";

/** A message as a provider takes it: built per turn from the log, never held. */
export type Message =
  | { role: "system"; content: Content }
  | { role: "user"; content: Content }
  | { role: "assistant"; content: Content; calls?: readonly ToolCall[] }
  | { role: "tool"; callId: string; content: Content; isError?: boolean };

/**
 * The position everything up to has been folded into a summary.
 *
 * One answer, because two callers need it: the projection skips what is folded,
 * and the loop refuses to cut at or behind it. They were the same reduce written
 * out twice.
 */
export function foldedThrough(entries: readonly Stored[]): number {
  return entries.reduce((at, entry) => entry.type === "summary" ? Math.max(at, entry.replaces) : at, 0);
}

/** Names the sender in the turn itself, since only text reaches the model. */
function labelled(input: Content, from: From | undefined): Content {
  if (!from) return input;
  const label = `[from ${from.kind} ${from.id}]`;
  return typeof input === "string"
    ? `${label}\n${input}`
    : [{ type: "text" as const, text: label }, ...input];
}

/**
 * The log projected into what a provider takes.
 *
 * Built fresh for every request and never held. That is the whole reason there
 * is no second transcript to drift from the log, and why nothing needs a test
 * proving two representations agree.
 */
export function toMessages(input: {
  instructions: Content;
  entries: readonly Stored[];
  context?: { run?: string; turn?: string };
  /**
   * Name each arrival's sender in the turn text, as `[from kind id]`.
   *
   * Off by default. `from` is provenance the log keeps whatever this says; an
   * application that renders its own attribution into the input it delivers
   * would otherwise hand the model two names for one sender, one of them a
   * session id that means nothing to it.
   */
  attribution?: boolean;
}): readonly Message[] {
  const messages: Message[] = [{ role: "system", content: input.instructions }];

  // Run-scoped context sits immediately after the instructions, inside the
  // cacheable prefix, because it does not change for the life of the run.
  if (input.context?.run) messages.push({ role: "system", content: input.context.run });

  // A summary folds everything up to `replaces`. The source entries stay in the
  // log — compaction changes what the model sees, never what happened.
  const cut = foldedThrough(input.entries);

  // A call whose result never committed. It happens when an activation ends
  // between asking and answering — cancelled, interrupted, or beaten to the
  // commit by another worker. The projection has to close it: a provider
  // rejects an assistant turn holding a call with no result, so leaving the gap
  // would make the session permanently unusable. What is said is what is known
  // — the call did not report back — and never an invented result.
  const answered = new Set(
    input.entries.filter((entry) => entry.type === "tool.finished").map((entry) => entry.callId),
  );

  for (const entry of input.entries) {
    // A summary folds like anything else it covers. Exempting the whole type
    // kept every summary ever written, so a long session carried a chain of
    // them whose content was already inside the newest — duplicated, and
    // rewriting the cached prefix each time one was added.
    if (entry.seq <= cut) continue;
    switch (entry.type) {
      case "hook.input":
        messages.push({ role: "user", content: entry.input });
        break;
      case "run.started":
        messages.push({
          role: "user",
          content: input.attribution ? labelled(entry.input, entry.from) : entry.input,
        });
        break;
      case "assistant": {
        messages.push({
          role: "assistant",
          content: entry.content,
          ...(entry.calls?.length ? { calls: entry.calls } : {}),
        });
        for (const call of entry.calls ?? []) {
          if (answered.has(call.callId)) continue;
          messages.push({
            role: "tool", callId: call.callId, isError: true,
            content: "This call did not report back: the activation ended before its result was committed.",
          });
        }
        break;
      }
      case "tool.finished":
        messages.push({
          role: "tool",
          callId: entry.callId,
          content: entry.result.content,
          ...(entry.result.isError ? { isError: true } : {}),
        });
        break;
      case "summary":
        // Delimited user context rather than an assistant turn: attributing a
        // summary to the assistant puts words in the model's mouth it never said.
        messages.push({ role: "user", content: `<summary>\n${entry.content}\n</summary>` });
        break;
      // Not model-visible: tool.started is bookkeeping and run.finished is a
      // boundary.
      case "tool.started":
      case "run.finished":
        break;
    }
  }

  // Turn-scoped context sits last, after the cache boundary, because it is for
  // this request only and must not be written into the cached prefix.
  if (input.context?.turn) messages.push({ role: "system", content: input.context.turn });
  return messages;
}
