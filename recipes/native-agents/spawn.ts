/**
 * Subagents, through the queue rather than around it.
 *
 * A child gets a goal and the context its parent chose to give it, and nothing
 * else — no parent transcript. That is Hermes' rule and it is the right one: a
 * child that inherits the conversation inherits its confusions, and pays for
 * them on every turn.
 *
 * The mechanism is one `append`. `enqueue` commits the delivery in the same
 * compare-and-swap that commits the turn asking for it, so a spawn is never
 * half-done: either the parent's tool call and the child's first message are
 * both in the log, or neither is. That is why `spawn` returns immediately
 * instead of awaiting an answer — the delivery does not exist until the turn
 * carrying it commits, so a tool that waited here would wait for itself.
 *
 * The answer comes back the same way. A child's `finished` hook delivers its
 * output to the parent at `priority: "turn"`, which folds into the parent's
 * running activation at its next tool-result boundary, or begins the next one
 * if it has already ended. Parent and child are the same kind of thing talking
 * over the same channel; nothing here is a special case for parenthood.
 */
import { defineTool, runAgent, type Agent, type Tool } from "aglib";
import { renderRun, type Sink } from "aglib/render";
import type { Delivery, Runnable, Store } from "aglib/store";
import { z } from "zod";

/** What a child records so its answer can find its way home. */
interface ChildRecord { parentSessionId?: string }

/** Whether the store handed out a subagent's session or its parent's. */
export const isChild = (metadata: unknown): boolean =>
  typeof (metadata as ChildRecord | null)?.parentSessionId === "string";

export function spawnTools(input: { store: Store; agent: { id: string; version: string } }): readonly Tool[] {
  return [
    defineTool({
      name: "spawn",
      description:
        "Hand a self-contained task to a subagent. It does not see this conversation, so state the goal and "
        + "every fact it needs. It has a shell and your skills, and cannot spawn further. Its answer arrives "
        + "as a message here when it is done, so say what you are doing and carry on.",
      annotations: { sequential: true },
      schema: z.object({
        goal: z.string().min(10).describe("What the subagent should achieve, and what to report back."),
        context: z.string().default("").describe("Facts it needs that it has no way to discover."),
      }),
      execute: async ({ goal, context: given }, call) => {
        const child = crypto.randomUUID();
        const created = await input.store.create({
          sessionId: child,
          agent: input.agent,
          key: `child:${call.sessionId}`,
          metadata: { parentSessionId: call.sessionId } satisfies ChildRecord,
        });
        if (!created.ok) return { content: `Cannot open a subagent: ${created.error.message}`, isError: true };

        call.enqueue({
          sessionId: child,
          input: given ? `${goal}\n\nContext you were given:\n${given}` : goal,
          from: { kind: "session", id: call.sessionId },
        });
        return { content: `Subagent ${child} started. Its report will arrive as a message.` };
      },
    }),
  ];
}

/** A child's report, addressed to whoever asked for it. */
export async function reportToParent(input: {
  store: Store;
  sessionId: string;
  output: string;
}): Promise<readonly Delivery[]> {
  const read = await input.store.read({ sessionId: input.sessionId });
  if (!read.ok) return [];
  const parent = (read.value.metadata as ChildRecord | null)?.parentSessionId;
  if (!parent) return [];
  return [{
    sessionId: parent,
    input: `Subagent ${input.sessionId} reports:\n\n${input.output}`,
    from: { kind: "session", id: input.sessionId },
    // The place that costs nothing: folded into the parent's turn if one is
    // running, and the start of the next one if not. Never an interrupt — the
    // parent asked for this and is not to be thrown off its work by getting it.
    priority: "turn",
  }];
}

/**
 * Run whatever the store hands out, until it hands out nothing.
 *
 * The whole of a worker. `next()` answers what has been asked for and takes a
 * claim with it, so two of these could run side by side without ever starting
 * the same session twice; one is enough for a single operator at a terminal.
 */
export async function drain(input: {
  store: Store;
  agentFor(claim: Runnable): Agent;
  signal?: AbortSignal;
  /** Where a drained run is shown. Each is labelled, because none of it was asked for here. */
  sink?: Sink;
}): Promise<void> {
  for (;;) {
    if (input.signal?.aborted) return;
    const claimed = await input.store.next({ ...(input.signal ? { signal: input.signal } : {}) });
    if (!claimed.ok) throw new Error(`store: ${claimed.error.message}`);
    if (!claimed.value) return;

    const run = runAgent({
      agent: input.agentFor(claimed.value),
      store: input.store,
      claim: claimed.value,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    // Rendered rather than summarised at the end: a subagent that takes a
    // minute was previously a minute of silence followed by a paragraph.
    if (input.sink) {
      await renderRun(run, { ...input.sink, label: `[${claimed.value.sessionId.slice(0, 4)}]` });
    } else {
      for await (const _ of run) { /* nothing is watching */ }
      await run.result;
    }
  }
}
