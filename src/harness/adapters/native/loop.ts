import type { Harness, HarnessContext, HarnessResult } from "../../harness.js";
import type { Entry, ToolCall, ToolResult } from "../../../session/entry.js";
import type { Message, Model, ModelSteerResult } from "../../../model/model.js";
import type { Delivery } from "../../../store/store.js";

export interface NativeHarnessOptions {
  model: Model;
  maxOutputTokens?: number;
  temperature?: number;
  /** How hard the model should think, where the provider supports it. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

interface Completion {
  callId: string;
  result: ToolResult;
  deliveries: readonly Delivery[];
}

/** Ask one tool call through the executor whose validation and policy own it. */
async function executeOne(context: HarnessContext, call: ToolCall): Promise<Completion> {
  if (!context.tools) {
    return {
      callId: call.callId,
      result: { content: `No tool named '${call.name}' is available.`, isError: true },
      deliveries: [],
    };
  }
  for await (const completion of context.tools.execute({ calls: [call], signal: context.signal })) {
    return completion;
  }
  return {
    callId: call.callId,
    result: { content: "Tool use cancelled", isError: true },
    deliveries: [],
  };
}

/** Calls left open by a process that died are never re-executed automatically. */
function unresolved(context: HarnessContext): ToolCall[] {
  const answered = new Set(
    context.entries().filter((entry) => entry.type === "tool.finished")
      .map((entry) => `${entry.runId}\u0000${entry.callId}`),
  );
  return context.entries().flatMap((entry) => entry.type === "assistant" && entry.runId === context.runId
    ? (entry.calls ?? []).filter((call) => !answered.has(`${entry.runId}\u0000${call.callId}`))
    : []);
}

/**
 * Ask the model, run what it asks for, repeat.
 *
 * The loop holds no transcript. Every turn it re-reads `context.history()`,
 * which projects the committed log, and every result it produces goes back
 * through `context.commit` before the next turn is built. There is exactly one
 * representation of the conversation and it is the log.
 */
export function createNativeHarness(options: NativeHarnessOptions): Harness {
  return {
    id: "native",
    recovery: "history",

    async run(context: HarnessContext): Promise<HarnessResult> {
      const { runId } = context;
      const pending = new Map<string, Promise<Completion>>();
      const asyncTools = new Set(
        context.tools?.list().filter((tool) => tool.async === true).map((tool) => tool.name) ?? [],
      );
      const canRunAsync = (call: ToolCall) =>
        options.model.asyncTools === true && call.async === true && asyncTools.has(call.name);
      let resultsForNextRequest = false;

      // This function begins with unresolved calls only on recovery. Calls
      // started below stay in `pending` until they have reported back.
      const abandoned = unresolved(context);
      if (abandoned.length) {
        await context.commit(abandoned.map((call): Entry => ({
          type: "tool.finished", runId, callId: call.callId,
          result: {
            content: "This call did not report back: the activation ended before its result was committed.",
            isError: true,
          },
        })));
      }

      const finish = async (completion: Completion) => {
        pending.delete(completion.callId);
        await context.commit([{
          type: "tool.finished", runId, callId: completion.callId, result: completion.result,
        }], completion.deliveries);
        resultsForNextRequest = true;
      };

      const firstPending = () => Promise.race(
        [...pending.entries()].map(async ([callId, completion]) => ({ callId, completion: await completion })),
      );

      const settlePending = async () => {
        while (pending.size) {
          const event = await firstPending();
          if (pending.has(event.callId)) await finish(event.completion);
        }
      };

      const startAsync = async (call: ToolCall) => {
        if (pending.has(call.callId)) return;
        if (!context.tools) {
          await finish(await executeOne(context, call));
          return;
        }
        await context.commit([{ type: "tool.started", runId, callId: call.callId }]);
        pending.set(call.callId, executeOne(context, call));
      };

      /** Commit foreground and background completions through the same writer. */
      const executeBatch = async (calls: readonly ToolCall[]) => {
        if (!context.tools) return;
        const iterator = context.tools.execute({ calls, signal: context.signal })[Symbol.asyncIterator]();
        let next = iterator.next();
        for (;;) {
          const event = await Promise.race([
            next.then((value) => ({ type: "batch" as const, value })),
            ...([...pending.entries()].map(async ([callId, completion]) => ({
              type: "tool" as const, value: { callId, completion: await completion },
            }))),
          ]);
          if (event.type === "tool") {
            if (pending.has(event.value.callId)) await finish(event.value.completion);
            continue;
          }
          if (event.value.done) return;
          await finish(event.value.value);
          await context.drain?.();
          next = iterator.next();
        }
      };

      /** Wait for one background result or newly delivered input. */
      const waitForWork = async (): Promise<void> => {
        for (;;) {
          const event = await Promise.race([
            firstPending().then((value) => ({ type: "tool" as const, value })),
            ...(context.waitForInput
              ? [context.waitForInput().then(() => ({ type: "input" as const }))]
              : []),
          ]);
          if (event.type === "tool") {
            if (pending.has(event.value.callId)) await finish(event.value.completion);
            return;
          }
          if (await context.drain?.()) return;
          if (context.signal.aborted) return;
        }
      };

      for (;;) {
        if (context.signal.aborted) return { status: "cancelled" };

        for (const hook of context.hooks ?? []) {
          const failure = await hook.beforeModel?.(context);
          if (failure) return { status: "failed", error: failure };
        }
        if (context.signal.aborted) return { status: "cancelled" };
        const history = context.history();
        // Results committed after this snapshot need a later request even if
        // the active generation can continue independently of them.
        resultsForNextRequest = false;

        // One cache mark, at the end of the system prefix: instructions plus
        // run-scoped context, which are fixed for the life of the run.
        const cacheAfter = history.findIndex((message) => message.role !== "system");
        const generationId = crypto.randomUUID();
        const startedAt = new Date().toISOString();
        const generation = options.model.generate({
          messages: history,
          ...(context.tools ? { tools: context.tools.list() } : {}),
          ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(cacheAfter > 0 ? { cacheAfter } : {}),
          signal: context.signal,
        });

        const launched = new Set<string>();
        const steering = new Set<Promise<ModelSteerResult>>();
        let inputForNext = false;
        let next = generation.next();
        let step;

        for (;;) {
          const event = await Promise.race([
            next.then((value) => ({ type: "model" as const, value })),
            ...([...pending.entries()].map(async ([callId, completion]) => ({
              type: "tool" as const, value: { callId, completion: await completion },
            }))),
            ...(context.waitForInput
              ? [context.waitForInput().then(() => ({ type: "input" as const }))]
              : []),
            ...([...steering].map(async (promise) => ({
              type: "steer" as const, promise, value: await promise,
            }))),
          ]);
          if (event.type === "tool") {
            if (pending.has(event.value.callId)) await finish(event.value.completion);
            continue;
          }
          if (event.type === "steer") {
            steering.delete(event.promise);
            if (event.value.status === "rejected") inputForNext = true;
            continue;
          }
          if (event.type === "input") {
            const arrived = await context.drain?.() ?? 0;
            if (!arrived) continue;
            const fresh = context.history().filter((message): message is Extract<Message, { role: "user" }> =>
              message.role === "user").slice(-arrived);
            if (!generation.steer || !fresh.length) {
              inputForNext = true;
              continue;
            }
            const attempt = generation.steer(fresh).catch((error): ModelSteerResult => ({
              status: "rejected",
              error: {
                code: "failed", retryable: true,
                message: error instanceof Error ? error.message : String(error),
              },
            }));
            steering.add(attempt);
            continue;
          }

          const current = event.value;
          if (current.done) { step = current; break; }
          const delta = current.value;
          if (delta.type === "text.delta") {
            context.emit({ ...delta, runId, generationId });
          }
          if (delta.type === "reasoning.delta") {
            context.emit({ type: "reasoning.delta", text: delta.text, runId, generationId });
          }
          if (delta.type === "tool-call.delta") {
            context.emit({
              type: "tool-call.delta", callId: delta.callId, arguments: delta.arguments, runId, generationId,
            });
          }
          if (delta.type === "tool-call.done" && canRunAsync(delta.call) && !launched.has(delta.call.callId)) {
            launched.add(delta.call.callId);
            await context.commit([{
              type: "assistant", runId, content: "", calls: [delta.call],
              generation: { id: generationId, startedAt },
            }]);
            await startAsync(delta.call);
          }
          next = generation.next();
        }

        for (const result of await Promise.all(steering)) {
          if (result.status === "rejected") inputForNext = true;
        }

        for (const hook of context.hooks ?? []) await hook.afterModel?.(context, step.value);
        if (!step.value.ok) {
          await settlePending();
          if ((inputForNext || resultsForNextRequest) && step.value.error.retryable &&
              step.value.error.code !== "cancelled" && !context.signal.aborted) continue;
          return step.value.error.code === "cancelled"
            ? { status: "cancelled" }
            : { status: "failed", error: step.value.error };
        }

        const endedAt = new Date().toISOString();
        const response = step.value.value;
        const calls = (response.message.calls ?? []).filter((call) => !launched.has(call.callId));

        await context.commit([{
          type: "assistant", runId, content: response.message.content,
          ...(calls.length ? { calls } : {}),
          usage: response.usage,
          ...(response.providerState ? { providerState: response.providerState } : {}),
          generation: {
            id: generationId, ...(response.model ? { model: response.model } : {}), startedAt, endedAt,
          },
        }]);

        if (response.finishReason === "length") {
          // A truncated response can carry half-parsed arguments that happen to
          // be valid JSON. Calls already completed and launched by the provider
          // remain real; the incomplete remainder is refused.
          await context.commit(calls.map((call): Entry => ({
            type: "tool.finished", runId, callId: call.callId,
            result: {
              content: "Not executed: the response was truncated. Reissue the call if it is still needed.",
              isError: true,
            },
          })));
          await settlePending();
          if ((calls.length || resultsForNextRequest) && !context.signal.aborted) continue;
          return { status: "failed", error: {
            code: "output-truncated",
            message: "The response stopped at the output limit before it was finished.",
            retryable: false,
          } };
        }

        if (response.finishReason === "refusal" && !calls.length) {
          await settlePending();
          if ((inputForNext || resultsForNextRequest) && !context.signal.aborted) continue;
          return { status: "failed", error: {
            code: "refused", message: "The provider declined to answer.", retryable: false,
          } };
        }

        const asyncCalls = calls.filter(canRunAsync);
        const synchronous = calls.filter((call) => !canRunAsync(call));

        if (calls.length && context.tools) {
          await context.commit(calls.map((call): Entry => ({
            type: "tool.started", runId, callId: call.callId,
          })));

          for (const call of asyncCalls) {
            pending.set(call.callId, executeOne(context, call));
          }

          if (synchronous.length) await executeBatch(synchronous);
        }

        if (calls.length && !context.tools) {
          for (const call of calls) await finish(await executeOne(context, call));
        }

        const arrived = await context.drain?.() ?? 0;
        if (synchronous.length || arrived || inputForNext || resultsForNextRequest || (calls.length && !context.tools)) continue;

        if (pending.size) {
          await waitForWork();
          continue;
        }

        return { status: "completed", output: response.message.content };
      }
    },
  };
}
