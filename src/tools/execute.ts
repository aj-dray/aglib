import type { Decide, Tool, ToolContext, ToolExecutor } from "./tool.js";
import type { Delivery } from "../session/entry.js";
import type { ToolCall, ToolResult } from "../session/entry.js";
import type { ToolSpec } from "./tool.js";

import type { JsonValue } from "../json.js";

/**
 * The one place a tool call becomes an effect: parse, validate, decide, run,
 * record. Failures are model-visible results, never throws — a model that gets
 * an exception learns nothing, while one that gets "invalid arguments: x must
 * be a number" fixes its next call.
 *
 * A denial is a result like any other, so the model reads why and can act on
 * it. Nothing here parks a batch waiting on a human: see `Decide`.
 */
export function createExecutor(input: {
  tools: readonly Tool[];
  decide?: Decide;
  sessionId: string;
  runId: string;
  enqueue(delivery: Delivery): void;
  report(callId: string, data: JsonValue): void;
  /** Adjacent read-only calls run together; this caps how many at once. */
  maxConcurrency?: number;
}): ToolExecutor {
  const byName = new Map<string, Tool>();
  for (const tool of input.tools) {
    if (byName.has(tool.spec.name)) throw new Error(`duplicate tool '${tool.spec.name}'`);
    byName.set(tool.spec.name, tool);
  }
  const limit = input.maxConcurrency ?? 8;
  const list = (): readonly ToolSpec[] => [...byName.values()].map((tool) => tool.spec);
  const failed = (content: string): ToolResult => ({ content, isError: true });

  return {
    list,
    async execute({ calls, signal }) {
      interface Planned {
        callId: string;
        concurrent: boolean;
        run(): Promise<ToolResult>;
      }
      const planned: Planned[] = [];
      const seen = new Set<string>();

      for (const call of calls) {
        const settled = (result: ToolResult): Planned =>
          ({ callId: call.callId, concurrent: true, run: async () => result });

        if (seen.has(call.callId)) { planned.push(settled(failed(`call id '${call.callId}' was reused`))); continue; }
        seen.add(call.callId);

        const tool = byName.get(call.name);
        if (!tool) { planned.push(settled(failed(`Unknown tool '${call.name}'`))); continue; }

        let raw: unknown;
        try { raw = JSON.parse(call.arguments); }
        catch { planned.push(settled(failed("Tool arguments are not valid JSON"))); continue; }

        const prepared = tool.prepare(raw);
        if (!prepared.ok) { planned.push(settled(prepared.error)); continue; }

        // Decisions always see parsed, schema-valid arguments — never the raw
        // string, and never before validation.
        const decision = input.decide
          ? await input.decide({
              tool: tool.spec, input: prepared.value.input,
              sessionId: input.sessionId, runId: input.runId, callId: call.callId,
            })
          : { action: "execute" as const };

        if (decision.action === "reject") {
          planned.push(settled(failed(`Tool use denied: ${decision.message}`)));
          continue;
        }

        const context: ToolContext = {
          sessionId: input.sessionId, runId: input.runId, callId: call.callId,
          signal: signal ?? new AbortController().signal,
          enqueue: input.enqueue,
          report: (data) => input.report(call.callId, data),
        };
        const annotations = tool.spec.annotations;
        planned.push({
          callId: call.callId,
          concurrent: annotations?.readOnly === true && annotations.sequential !== true,
          run: async () => {
            try { return await prepared.value.run(context); }
            catch (error) { return failed(error instanceof Error ? error.message : String(error)); }
          },
        });
      }

      const results: { callId: string; result: ToolResult }[] = [];
      let index = 0;
      while (index < planned.length) {
        if (signal?.aborted) {
          for (const item of planned.slice(index)) {
            results.push({ callId: item.callId, result: failed("Tool use cancelled") });
          }
          break;
        }
        let end = index + 1;
        if (planned[index]!.concurrent) {
          while (end < planned.length && planned[end]!.concurrent && end - index < limit) end += 1;
        }
        const segment = planned.slice(index, end);
        const settled = await Promise.all(segment.map((item) => item.run()));
        segment.forEach((item, offset) => results.push({ callId: item.callId, result: settled[offset]! }));
        index = end;
      }
      return { results };
    },
  };
}

export type { ToolCall };
