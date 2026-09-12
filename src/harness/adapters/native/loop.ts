import type { Harness, HarnessContext, HarnessResult } from "../../harness.js";
import type { Entry } from "../../../session/entry.js";
import type { Model } from "../../../model/model.js";

export interface NativeHarnessOptions {
  model: Model;
  maxOutputTokens?: number;
  temperature?: number;
  /** How hard the model should think, where the provider supports it. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
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

      for (;;) {
        if (context.signal.aborted) return { status: "cancelled" };

        for (const hook of context.hooks ?? []) {
          const failure = await hook.beforeModel?.(context);
          if (failure) return { status: "failed", error: failure };
        }
        if (context.signal.aborted) return { status: "cancelled" };
        const history = context.history();

        // One cache mark, at the end of the system prefix: instructions plus
        // run-scoped context, which are fixed for the life of the run.
        const cacheAfter = history.findIndex((message) => message.role !== "system");

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

        let step = await generation.next();
        while (!step.done) {
          const delta = step.value;
          if (delta.type === "text.delta") context.emit({ type: "text.delta", text: delta.text });
          if (delta.type === "reasoning.delta") context.emit({ type: "reasoning.delta", text: delta.text });
          if (delta.type === "tool-call.delta") {
            context.emit({ type: "tool-call.delta", callId: delta.callId, arguments: delta.arguments });
          }
          step = await generation.next();
        }
        for (const hook of context.hooks ?? []) await hook.afterModel?.(context, step.value);
        if (!step.value.ok) {
          return step.value.error.code === "cancelled"
            ? { status: "cancelled" }
            : { status: "failed", error: step.value.error };
        }

        const endedAt = new Date().toISOString();
        const response = step.value.value;
        const calls = response.message.calls ?? [];

        await context.commit([{
          type: "assistant", runId, content: response.message.content,
          ...(calls.length ? { calls } : {}),
          usage: response.usage,
          ...(response.providerState ? { providerState: response.providerState } : {}),
          generation: { ...(response.model ? { model: response.model } : {}), startedAt, endedAt },
        }]);

        if (!calls.length) {
          // The reason the model stopped decides the outcome, and it decides it
          // before the absence of tool calls does. A turn cut off by the output
          // ceiling or declined by a safety classifier is not an answer, and
          // reporting either as `completed` hands the caller a truncated or
          // refused response dressed as a finished one.
          if (response.finishReason === "length") {
            return { status: "failed", error: {
              code: "output-truncated",
              message: "The response stopped at the output limit before it was finished.",
              retryable: false,
            } };
          }
          if (response.finishReason === "refusal") {
            return { status: "failed", error: {
              code: "refused",
              message: "The provider declined to answer.",
              retryable: false,
            } };
          }
          return { status: "completed", output: response.message.content };
        }

        if (response.finishReason === "length") {
          // A truncated response can carry half-parsed arguments that happen to
          // be valid JSON. None of the batch runs; the model is told why and
          // can reissue.
          await context.commit(calls.map((call): Entry => ({
            type: "tool.finished", runId, callId: call.callId,
            result: { content: "Not executed: the response was truncated. Reissue the call if it is still needed.", isError: true },
          })));
          continue;
        }

        if (!context.tools) {
          await context.commit(calls.map((call): Entry => ({
            type: "tool.finished", runId, callId: call.callId,
            result: { content: `No tool named '${call.name}' is available.`, isError: true },
          })));
          continue;
        }

        // Recorded before anything runs. On restart an unmatched `tool.started`
        // is how we know the process died mid-effect — and why nothing is
        // re-executed automatically.
        await context.commit(calls.map((call): Entry => ({ type: "tool.started", runId, callId: call.callId })));

        const outcome = await context.tools.execute({ calls, signal: context.signal });
        await context.commit(outcome.results.map(({ callId, result }): Entry => ({
          type: "tool.finished", runId, callId, result,
        })));

        // Nothing is half-done here: every call asked for has been answered and
        // committed. Anything waiting is folded in before the next request is
        // built, so a message delivered to a busy session is read without the
        // activation having to be ended and its work thrown away.
        await context.drain?.();
      }
    },
  };
}
