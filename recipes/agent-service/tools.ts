/**
 * What every agent in the service can do to every other one.
 *
 * These replace each agent's private subagent tool. A native subagent runs
 * inside one session and disappears with it; these produce work the service
 * can see, address and interrupt. The substitution is enforced in `decide`
 * (see `worker.ts`) rather than by per-agent configuration, because the
 * decision function is the one lever every agent shares.
 */
import { defineTool, runAgent, textOf, type Tool, type ToolContext, type ToolResult } from "aglib";
import type { Delivery, JsonValue } from "aglib";
import type { SessionSummary, Store } from "aglib/store";
import { createNativeHarness } from "aglib/harness";
import { z } from "zod";
import { harnesses, type HarnessId, type SessionRecord } from "./harnesses.ts";
import { chooseModel } from "./model.ts";


/** Sessions currently running in this process, so an interrupt can reach one. */
export type Running = Map<string, AbortController>;

/** Everything dispatchable. One list, derived from the capability table. */
const harnessIds = harnesses.map((harness) => harness.id) as [HarnessId, ...HarnessId[]];

/**
 * One tool, declared once.
 *
 * Two harness families consume these: the native loop takes them as `Tool`s
 * through `defineTool`, and the Claude Agent SDK takes the same name,
 * description and schema as an in-process MCP server. Declaring them twice
 * would be two names for one fact, and they would drift.
 */
export interface ServiceToolDefinition {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  annotations?: Tool["spec"]["annotations"];
  execute(args: Record<string, never>, context: ToolContext): ToolResult | Promise<ToolResult>;
}

export const define = <S extends z.ZodObject<z.ZodRawShape>>(definition: {
  name: string;
  description: string;
  schema: S;
  annotations?: Tool["spec"]["annotations"];
  execute(args: z.output<S>, context: ToolContext): ToolResult | Promise<ToolResult>;
}): ServiceToolDefinition => definition as unknown as ServiceToolDefinition;

export function serviceTools(input: { store: Store; sessionId: string; running: Running }): readonly Tool[] {
  return toolDefinitions(input).map((definition) => defineTool(definition as never));
}

export function toolDefinitions(input: { store: Store; sessionId: string; running: Running }): readonly ServiceToolDefinition[] {
  const { store, sessionId } = input;

  const summarize = (session: SessionSummary) => {
    const record = (session.metadata ?? {}) as unknown as SessionRecord;
    return {
      sessionId: session.sessionId,
      title: record.title ?? "",
      harness: record.harness ?? "",
      model: record.model ?? "",
      mine: record.parentSessionId === sessionId,
      isMe: session.sessionId === sessionId,
      updatedAt: session.updatedAt,
    };
  };

  return [
    define({
      name: "dispatch",
      description:
        "Start another agent on its own task, in its own session and its own sandbox, with its own harness and model. " +
        "Returns immediately: the agent runs independently and messages you when it finishes. Use this for work that is " +
        "large, long-running, or better done by a different agent.",
      schema: z.object({
        task: z.string().describe("The complete task. The new agent sees only this, not your conversation."),
        harness: z.enum(harnessIds).default("claude-code"),
        model: z.string().optional(),
        title: z.string().describe("A short label for the session list."),
      }),
      execute: async ({ task, harness, model, title }, context) => {
        const child = crypto.randomUUID();
        const record: SessionRecord = {
          title, harness, parentSessionId: sessionId,
          ...(model ? { model } : {}),
        };
        const created = await store.create({
          sessionId: child,
          agent: { id: `agent-${harness}`, version: "1" },
          // The key is the parent's id, so one query lists an agent's children.
          key: sessionId,
          metadata: record as unknown as JsonValue,
        });
        if (!created.ok) return { content: `Could not dispatch: ${created.error.message}`, isError: true };
        // Enqueued through this turn's own commit: if the turn does not commit,
        // the child was never started.
        context.enqueue({ sessionId: child, input: task });
        return {
          content: `Dispatched ${harness} agent in session ${child}. It will message you when it finishes.`,
          details: { sessionId: child },
        };
      },
    }),

    define({
      name: "delegate",
      description:
        "Ask a helper to do one bounded piece of work and wait for its answer. It has no session, no sandbox and no " +
        "memory. Use this for a focused question; use dispatch for anything that needs tools, time, or its own identity.",
      schema: z.object({
        task: z.string(),
        instructions: z.string().optional().describe("How the helper should behave."),
      }),
      execute: async ({ task, instructions }, context) => {
        const model = chooseModel({});
        if (!model.ok) return { content: model.error.message, isError: true };
        // No store: the helper's log lives and dies in memory. That is the
        // whole difference from dispatch, and it is one missing argument.
        const run = runAgent({
          agent: {
            id: "delegate", version: "1",
            instructions: instructions ?? "Answer the task directly and completely. You have no tools.",
            harness: createNativeHarness({ model: model.value }),
            limits: { maxTurns: 4 },
          },
          input: task,
          signal: context.signal,
        });
        const result = await run.result;
        return result.status === "completed"
          ? { content: textOf(result.output) }
          : { content: `The helper did not finish: ${result.status}.`, isError: true };
      },
    }),

    define({
      name: "archive",
      description:
        "Put a session away when its work is finished. It leaves the list; nothing is deleted and the transcript " +
        "stays readable. Archive yourself when you are done, and archive an agent you dispatched once you have " +
        "read its result.",
      schema: z.object({
        sessionId: z.string().describe("Yours, or one you dispatched."),
      }),
      execute: async ({ sessionId: target }) => {
        if (target !== sessionId) {
          const mine = await store.list({ key: sessionId, limit: 100 });
          if (!mine.ok || !mine.value.some((session) => session.sessionId === target)) {
            return { content: `Not yours to archive: ${target}.`, isError: true };
          }
        }
        const read = await store.read({ sessionId: target, afterSeq: Number.MAX_SAFE_INTEGER });
        if (!read.ok) return { content: `No session ${target}.`, isError: true };
        const put = await store.append({
          sessionId: target, expectedSeq: read.value.seq, entries: [],
          metadata: { archived: true } as JsonValue,
        });
        return put.ok
          ? { content: `Archived ${target}.` }
          : { content: `Could not archive: ${put.error.message}`, isError: true };
      },
    }),

    define({
      name: "sessions",
      description:
        "List every agent session in the service: the ones you dispatched, and everyone else's. Use it to find an agent " +
        "to message, or to see whether work you dispatched has finished.",
      annotations: { readOnly: true },
      schema: z.object({}),
      execute: async () => {
        const [mine, roots] = await Promise.all([
          store.list({ key: sessionId, limit: 100 }),
          store.list({ limit: 100 }),
        ]);
        if (!mine.ok || !roots.ok) return { content: "Could not list sessions.", isError: true };
        const seen = new Map<string, ReturnType<typeof summarize>>();
        for (const session of [...mine.value, ...roots.value]) seen.set(session.sessionId, summarize(session));
        const listed = [...seen.values()];
        return {
          content: listed.length
            ? listed.map((session) =>
                `${session.sessionId}  ${session.mine ? "[yours]" : session.isMe ? "[you]" : "[other]"}  ` +
                `${session.harness}  ${session.title}`).join("\n")
            : "No other sessions.",
          details: listed as unknown as JsonValue,
        };
      },
    }),

    define({
      name: "send",
      description:
        "Send a message to any agent session. Priority is where it lands in that agent's loop, not how urgent it is: " +
        "'interrupt' ends the turn it is running, losing that turn's uncommitted work, so the next one begins with " +
        "your message; 'turn' folds into the turn it is running, before its next model call, losing nothing; " +
        "'next' waits for the start of its next turn. An agent that cannot fold a 'turn' in reads it next instead.",
      schema: z.object({
        sessionId: z.string(),
        message: z.string(),
        priority: z.enum(["interrupt", "turn", "next"]).default("next"),
      }),
      execute: async ({ sessionId: target, message, priority }, context) => {
        if (target === sessionId) return { content: "That is this session.", isError: true };

        // Checked here, where the model can be told and can correct itself. A
        // delivery to a session that does not exist fails the whole write, so a
        // mistyped id used to cost the sender its terminal commit and every
        // other delivery it had made — reported to it as "Delivered".
        const exists = await input.store.read({ sessionId: target, afterSeq: Number.MAX_SAFE_INTEGER });
        if (!exists.ok) {
          return { content: `No session ${target}. Use \`sessions\` to see what is here.`, isError: true };
        }

        context.enqueue({
          sessionId: target, input: message, from: { kind: "session", id: sessionId }, priority, id: context.callId,
        });
        // Each place is one thing, so the answer is one sentence — and where
        // this service cannot reach the place asked for, it says the message
        // waits rather than doing something more destructive instead.
        const live = input.running.get(target);
        const folds = (exists.value.agent.id ?? "").endsWith("native");
        if (priority === "next" || !live) {
          return { content: "Delivered. It will be read at the start of that agent's next turn." };
        }
        if (priority === "interrupt") {
          live.abort();
          return { content: "Delivered: that agent's current turn was ended, so it reads this first. Whatever that turn had not committed is gone." };
        }
        if (!folds) {
          return { content: "Delivered, but that agent's harness has no point mid-turn to read it at, so it waits for the start of its next turn." };
        }
        return { content: "Delivered: it will be read at that agent's next safe point, without losing the work in flight." };
      },
    }),
  ];
}

/**
 * Run one of these tools for an agent that is not using our executor.
 *
 * A foreign agent reaches them over MCP, outside any turn of ours, so its
 * deliveries commit in their own write rather than with the caller's turn. The
 * native harness gets the atomic version; this is the honest difference, and
 * the record of the call still lands in the caller's log through the adapter.
 */
export async function callServiceTool(input: {
  store: Store;
  running: Running;
  sessionId: string;
  /** The definitions to search. Defaults to the orchestration tools alone. */
  tools?: readonly ServiceToolDefinition[];
  name: string;
  arguments: JsonValue;
}): Promise<{ content: string; isError: boolean }> {
  const available = (input.tools ?? toolDefinitions(input)).map((definition) => defineTool(definition as never));
  const tool = available.find((candidate) => candidate.spec.name === input.name);
  if (!tool) return { content: `No tool named ${input.name}.`, isError: true };

  const prepared = tool.prepare(input.arguments);
  if (!prepared.ok) return { content: textOf(prepared.error.content), isError: true };

  // The whole envelope, not a fragment of it. This path used to reduce a
  // `Delivery` to its target and its text, so every foreign agent — which is
  // most of them here — lost the sender, the urgency and the id that makes a
  // retry idempotent. The native path kept all four; there was no reason for
  // this one not to.
  const deliveries: Delivery[] = [];
  const result = await prepared.value.run({
    sessionId: input.sessionId,
    runId: "service",
    callId: crypto.randomUUID(),
    signal: AbortSignal.timeout(600_000),
    enqueue: (delivery) => deliveries.push(delivery),
    report: () => undefined,
  });

  if (deliveries.length) {
    const read = await input.store.read({ sessionId: input.sessionId, afterSeq: Number.MAX_SAFE_INTEGER });
    const at = read.ok ? read.value.seq : 0;
    const written = await input.store.append({
      sessionId: input.sessionId, expectedSeq: at, entries: [], enqueue: deliveries,
    });
    // Reporting success for a write that failed is how an agent comes to
    // believe it has handed work to someone who never received it.
    if (!written.ok) {
      return { content: `The message was not delivered: ${written.error.message}`, isError: true };
    }
  }
  return { content: textOf(result.content), isError: result.isError === true };
}

/** What the stdio MCP bridge publishes. Derived from the tools, never written twice. */
export const toolSpecs = (store: Store, running: Running) =>
  serviceTools({ store, sessionId: "", running }).map((tool) => ({
    name: tool.spec.name,
    description: tool.spec.description,
    inputSchema: tool.spec.parameters,
  }));
