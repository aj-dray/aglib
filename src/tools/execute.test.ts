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

async function execute(executor: ReturnType<typeof createExecutor>, calls: readonly ReturnType<typeof call>[]) {
  return Array.fromAsync(executor.execute({ calls }));
}

test("invalid arguments come back as a model-visible result, not a throw", async () => {
  const executor = createExecutor({ tools: [echo], ...base });
  const outcome = await execute(executor, [call("c1", "echo", { text: 42 })]);
  expect(outcome[0]?.result.isError).toBe(true);
  // A model that receives an exception learns nothing; one that receives this fixes its next call.
  expect(String(outcome[0]?.result.content)).toContain("Invalid arguments");
});

test("an unknown tool is reported to the model rather than failing the run", async () => {
  const executor = createExecutor({ tools: [echo], ...base });
  const outcome = await execute(executor, [call("c1", "nope", {})]);
  expect(String(outcome[0]?.result.content)).toContain("Unknown tool");
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

  const outcome = await execute(executor, [call("c1", "spend", { amount: 500 })]);

  expect(ran).toBe(0);
  expect(outcome[0]?.result.isError).toBe(true);
  expect(String(outcome[0]?.result.content)).toContain("ask an operator");
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
  const outcome = await execute(executor, [call("c1", "echo", { text: "hi" })]);
  expect(seen).toEqual([{ text: "hi" }]);
  expect(ran).toBe(0);
  expect(String(outcome[0]?.result.content)).toContain("not allowed");
});

test("a reused call id is refused rather than executed twice", async () => {
  const executor = createExecutor({ tools: [echo], ...base });
  const outcome = await execute(executor,
    [call("c1", "echo", { text: "a" }), call("c1", "echo", { text: "b" })]);
  expect(outcome.some((completion) => String(completion.result.content).includes("reused"))).toBe(true);
});

test("a throwing tool becomes an error result, not an escaped exception", async () => {
  const exploding = defineTool({
    name: "boom", description: "boom", schema: z.object({}),
    execute: () => { throw new Error("kaboom"); },
  });
  const executor = createExecutor({ tools: [exploding], ...base });
  const outcome = await execute(executor, [call("c1", "boom", {})]);
  expect(outcome[0]?.result).toEqual({ content: "kaboom", isError: true });
});

test("concurrent calls report as each finishes and keep their own deliveries", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const work = defineTool({
    name: "work", description: "work", schema: z.object({ target: z.string() }),
    annotations: { readOnly: true },
    execute: async ({ target }, context) => {
      context.enqueue({ sessionId: target, input: `from ${target}` });
      if (target === "slow") await slow;
      return { content: target };
    },
  });
  const executor = createExecutor({ tools: [work], ...base });
  const stream = executor.execute({ calls: [
    call("slow-call", "work", { target: "slow" }),
    call("fast-call", "work", { target: "fast" }),
  ] })[Symbol.asyncIterator]();

  const first = await stream.next();
  expect(first.done).toBe(false);
  if (first.done) return;
  expect(first.value.callId).toBe("fast-call");
  expect(first.value.deliveries.map((delivery) => delivery.sessionId)).toEqual(["fast"]);
  release();
  const second = await stream.next();
  expect(second.done).toBe(false);
  if (!second.done) {
    expect(second.value.callId).toBe("slow-call");
    expect(second.value.deliveries.map((delivery) => delivery.sessionId)).toEqual(["slow"]);
  }
});
