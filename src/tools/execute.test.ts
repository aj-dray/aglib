import { expect, test } from "bun:test";
import { z } from "zod";
import { createExecutor } from "./execute.js";
import { defineTool } from "./tool.js";

const echo = defineTool({
  name: "echo", description: "echo", annotations: { readOnly: true },
  schema: z.object({ text: z.string() }),
  execute: ({ text }) => ({ content: text }),
});

const base = { sessionId: "s", runId: "r", enqueue: () => {}, report: () => {} };
const call = (callId: string, name: string, args: unknown) =>
  ({ callId, name, arguments: JSON.stringify(args) });

test("invalid arguments come back as a model-visible result, not a throw", async () => {
  const executor = createExecutor({ tools: [echo], ...base });
  const outcome = await executor.execute({ calls: [call("c1", "echo", { text: 42 })] });
  expect(outcome.results[0]?.result.isError).toBe(true);
  // A model that receives an exception learns nothing; one that receives this fixes its next call.
  expect(String(outcome.results[0]?.result.content)).toContain("Invalid arguments");
});

test("an unknown tool is reported to the model rather than failing the run", async () => {
  const executor = createExecutor({ tools: [echo], ...base });
  const outcome = await executor.execute({ calls: [call("c1", "nope", {})] });
  expect(String(outcome.results[0]?.result.content)).toContain("Unknown tool");
});

test("a call the application refuses never reaches the tool, and the model is told why", async () => {
  // There used to be a third outcome that parked the batch waiting on a human,
  // and nothing anywhere could resume it. A refusal is a result the model reads
  // and can act on, and it works the same in every harness.
  let ran = 0;
  const counted = defineTool({
    name: "spend", description: "spend", schema: z.object({ amount: z.number() }),
    execute: () => { ran += 1; return { content: "spent" }; },
  });
  const executor = createExecutor({
    tools: [counted], ...base,
    decide: ({ input }) => (input as { amount: number }).amount > 100
      ? { action: "reject", message: "over the limit; ask an operator to approve it" }
      : { action: "execute" },
  });

  const outcome = await executor.execute({ calls: [call("c1", "spend", { amount: 500 })] });

  expect(ran).toBe(0);
  expect(outcome.results[0]?.result.isError).toBe(true);
  expect(String(outcome.results[0]?.result.content)).toContain("ask an operator");
});

test("a decision sees parsed arguments, and a rejection never reaches the tool", async () => {
  let ran = 0;
  const seen: unknown[] = [];
  const counted = defineTool({
    name: "echo", description: "echo", schema: z.object({ text: z.string() }),
    execute: () => { ran += 1; return { content: "done" }; },
  });
  const executor = createExecutor({
    tools: [counted], ...base,
    decide: ({ input }) => { seen.push(input); return { action: "reject", message: "not allowed" }; },
  });
  const outcome = await executor.execute({ calls: [call("c1", "echo", { text: "hi" })] });
  expect(seen).toEqual([{ text: "hi" }]);
  expect(ran).toBe(0);
  expect(String(outcome.results[0]?.result.content)).toContain("not allowed");
});

test("a reused call id is refused rather than executed twice", async () => {
  const executor = createExecutor({ tools: [echo], ...base });
  const outcome = await executor.execute({
    calls: [call("c1", "echo", { text: "a" }), call("c1", "echo", { text: "b" })],
  });
  expect(String(outcome.results[1]?.result.content)).toContain("reused");
});

test("a throwing tool becomes an error result, not an escaped exception", async () => {
  const exploding = defineTool({
    name: "boom", description: "boom", schema: z.object({}),
    execute: () => { throw new Error("kaboom"); },
  });
  const executor = createExecutor({ tools: [exploding], ...base });
  const outcome = await executor.execute({ calls: [call("c1", "boom", {})] });
  expect(outcome.results[0]?.result).toEqual({ content: "kaboom", isError: true });
});
