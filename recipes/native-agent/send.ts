/**
 * `send` — the door out of a turn.
 *
 * An activation has exactly one answer, `RunResult.output`, handed to whoever
 * asked for it. That is right when somebody asked. It is not the shape of an
 * agent woken by a schedule or a peer, where nobody is watching a stream and
 * the assistant's own text is a scratchpad nobody reads — there, an explicit
 * send is the only thing that reaches anyone at all.
 *
 * A tool rather than a field on the model's output, because sending a message
 * is an effect and `decide` runs on a tool call before it happens.
 *
 * **A channel is a function**, which is the same rule `channel.ts` states for
 * the inbound half: no gateway type, no registry, no adapter. Outbound it takes
 * what it can deliver and answers whether it did. A terminal is a pipe that
 * cannot fail; anything reached over a network says why it did not.
 *
 * **The recipient is an address, not a kind**, so a person and a subagent are
 * interchangeable on the other end. What is not interchangeable is the
 * guarantee, and the result says which one you got: a delivery to a session
 * commits in the same compare-and-swap as the turn that asked for it, while a
 * channel is a call to somewhere else.
 *
 * A session id is not scoped here. That is a fact about this recipe rather than
 * an oversight — one operator, one machine, one `~/.agent`, so every session in
 * the store is already theirs. An application with more than one tenant's
 * agents in one store would bound what an address may name.
 */
import { defineTool, ok, type Failure, type Result, type Tool } from "aglib";
import type { Sink } from "aglib/render";
import type { Store } from "aglib/store";
import { z } from "zod";

/** Deliver a message, and say whether it arrived. */
export type Channel = (content: string) => Promise<Result<void, Failure>>;

/** The one this recipe has. `status`, because a message is not the answer. */
export const terminalChannel = (sink: Sink): Channel => async (content) => {
  (sink.status ?? sink.write)(`${content}\n`);
  return ok(undefined);
};

export function sendTools(input: {
  channels: Readonly<Record<string, Channel>>;
  /** Read to check an address before committing to it — see `execute` below. */
  store: Store;
}): readonly Tool[] {
  const named = Object.keys(input.channels);
  return [
    defineTool({
      name: "send",
      description:
        "Say something now, without ending your turn. Use it when a task will take a while and somebody "
        + `is waiting, or to message another session. \`to\` is one of: ${named.join(", ")} — or a session id.`,
      schema: z.object({
        to: z.string().describe(`One of: ${named.join(", ")}, or the id of a session to message.`),
        content: z.string().min(1).describe("What to say. It is delivered as written."),
      }),
      execute: async ({ to, content }, call) => {
        const channel = input.channels[to];
        if (channel) {
          const sent = await channel(content);
          return sent.ok
            ? { content: `Sent to ${to}.` }
            : { content: `Could not send to ${to}: ${sent.error.message}`, isError: true };
        }
        // Checked before it is enqueued, and this is not defensiveness. A
        // delivery to a session that does not exist is refused by the store,
        // that refusal rejects the whole commit, and the harness must not catch
        // it — so a model mistyping an id would destroy its own turn.
        //
        // `afterSeq` past the end asks the honest cheap question: the session
        // row, and none of its entries. Without it `read` parses every entry in
        // the recipient's log to answer whether the session exists at all, and
        // this one is a conversation that never ends.
        const known = await input.store.read({ sessionId: to, afterSeq: Number.MAX_SAFE_INTEGER });
        if (!known.ok) {
          return { content: `No channel or session '${to}'. One of: ${named.join(", ")}, or a session id.`, isError: true };
        }
        // The place that costs nothing: folded into the recipient's running
        // activation at its next tool-result boundary, or the start of its next
        // one. Never an interrupt — nobody's work is destroyed to be heard.
        call.enqueue({ sessionId: to, input: content, priority: "turn" });
        return { content: `Queued for session ${to}, and delivered when this turn commits.` };
      },
    }),
  ];
}
