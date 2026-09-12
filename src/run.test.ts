import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { runAgent } from "./run.js";
import { defineTool } from "./tools/tool.js";
import { createCompactionHook } from "./harness/adapters/native/compaction.js";
import { createNativeHarness } from "./harness/adapters/native/loop.js";
import { createFakeModel } from "./model/adapters/fake/index.js";
import { createSqliteStore } from "./store/adapters/sqlite.js";
import { textOf } from "./content.js";
import { ok } from "./result.js";
import type { Agent } from "./agent.js";
import type { Message, Model } from "./model/model.js";

const ledger = defineTool({
  name: "read_ledger", description: "read", annotations: { readOnly: true },
  schema: z.object({}),
  execute: () => ({ content: "1250" }),
});

const agentWith = (model: Model, over: Partial<Agent> = {}): Agent => ({
  id: "a", version: "1", instructions: "Answer from the ledger.",
  harness: createNativeHarness({ model }), tools: [ledger], ...over,
});

const call = { callId: "c1", name: "read_ledger", arguments: "{}" };

test("a tool round trip is recorded in full, in order", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  const run = runAgent({
    agent: agentWith(createFakeModel([{ calls: [call] }, { text: "The balance is 1250." }])),
    store, sessionId: "s", input: "balance?",
  });
  const result = await run.result;
  expect(result.status).toBe("completed");
  if (result.status !== "completed") return;
  expect(textOf(result.output)).toBe("The balance is 1250.");

  const read = await store.read({ sessionId: "s" });
  if (!read.ok) throw new Error("read failed");
  expect(read.value.entries.map((entry) => entry.type)).toEqual([
    "run.started", "assistant", "tool.started", "tool.finished", "assistant", "run.finished",
  ]);
  // `tool.started` lands before the effect runs: an unmatched one after a crash
  // is how a restart knows the process died mid-effect.
  const started = read.value.entries.findIndex((entry) => entry.type === "tool.started");
  const finished = read.value.entries.findIndex((entry) => entry.type === "tool.finished");
  expect(started).toBeLessThan(finished);
});

test("the same agent runs with no store at all", async () => {
  const run = runAgent({
    agent: agentWith(createFakeModel([{ text: "no store needed" }])),
    input: "hi",
  });
  const result = await run.result;
  expect(result.status).toBe("completed");
  // Durability is a composition choice, not a different program.
  if (result.status === "completed") expect(textOf(result.output)).toBe("no store needed");
});

test("a claim read at a position the session has left is refused before anything happens", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({ sessionId: "s", agent: { id: "a", version: "1" } });
  await store.append({
    sessionId: "s", expectedSeq: 0, entries: [], enqueue: [{ sessionId: "s", input: "new" }],
  });
  const claimed = await store.next({});
  if (!claimed.ok || !claimed.value) throw new Error("expected a claim");

  // Somebody else advances the session between the claim and the run.
  await store.append({ sessionId: "s", expectedSeq: 0, entries: [{ type: "run.started", runId: "x", input: "old" }] });

  const result = await runAgent({
    agent: agentWith(createFakeModel([{ text: "should not run" }])),
    store, claim: claimed.value,
  }).result;
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.code).toBe("conflict");

  // The loser destroyed nothing: the delivery it was carrying is still queued.
  const after = await store.read({ sessionId: "s" });
  expect(after.ok && after.value.pending).toHaveLength(1);
});

test("a refused call finishes the run instead of parking it", async () => {
  const model = createFakeModel([
    { calls: [{ callId: "c1", name: "read_ledger", arguments: "{}" }] },
    { text: "I was not allowed to read it." },
  ]);
  const run = runAgent({
    agent: agentWith(model, { decide: () => ({ action: "reject", message: "not this one" }) }),
    input: "What is the balance?",
  });
  const seen: string[] = [];
  for await (const update of run) if (update.type === "entry") seen.push(update.entry.type);
  const result = await run.result;

  expect(result.status).toBe("completed");
  expect(seen).toContain("run.finished");
});

test("streamed text is provisional; committed entries are the record", async () => {
  const run = runAgent({
    agent: agentWith(createFakeModel([{ text: "hello world" }])),
    input: "hi",
  });
  const streamed: string[] = [];
  const entries: string[] = [];
  for await (const update of run) {
    if (update.type === "text.delta") streamed.push(update.text);
    if (update.type === "entry") entries.push(update.entry.type);
  }
  await run.result;
  expect(streamed.join("")).toBe("hello world");
  expect(entries).toEqual(["run.started", "assistant", "run.finished"]);
});

test("a complete asynchronous call starts while its generation keeps streaming", async () => {
  const trace: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let markToolFinished!: () => void;
  const toolFinished = new Promise<void>((resolve) => { markToolFinished = resolve; });
  const asyncCall = { callId: "async-1", name: "background", arguments: "{}", async: true };
  let generation = 0;
  const model: Model = {
    id: "async-model", asyncTools: true,
    async *generate(request) {
      generation += 1;
      if (generation === 1) {
        yield { type: "tool-call.done", call: asyncCall };
        trace.push("model-continued");
        release();
        await toolFinished;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return ok({
          message: { content: "I started that.", calls: [asyncCall] },
          finishReason: "tool-calls", usage: {},
        });
      }
      expect(request.messages.some((message) => message.role === "tool" && message.callId === "async-1")).toBe(true);
      return ok({ message: { content: "It finished." }, finishReason: "stop", usage: {} });
    },
  };
  const background = defineTool({
    name: "background", description: "background", schema: z.object({}), async: true,
    execute: async () => {
      trace.push("tool-started");
      await gate;
      trace.push("tool-finished");
      markToolFinished();
      return { content: "done" };
    },
  });
  const store = createSqliteStore({ database: new Database(":memory:") });
  const result = await runAgent({
    agent: agentWith(model, { tools: [background] }), store, sessionId: "s", input: "start it",
  }).result;

  expect(result.status).toBe("completed");
  expect(trace).toEqual(["tool-started", "model-continued", "tool-finished"]);
  const read = await store.read({ sessionId: "s" });
  if (!read.ok) throw new Error("read failed");
  const started = read.value.entries.findIndex((entry) => entry.type === "tool.started" && entry.callId === "async-1");
  const finished = read.value.entries.findIndex((entry) => entry.type === "tool.finished" && entry.callId === "async-1");
  const generationFinished = read.value.entries.findIndex((entry) =>
    entry.type === "assistant" && entry.content === "I started that.");
  expect(started).toBeGreaterThan(-1);
  expect(started).toBeLessThan(finished);
  expect(finished).toBeLessThan(generationFinished);
});

test("an early asynchronous call entry counts with its completed generation as one turn", async () => {
  const asyncCall = { callId: "async-1", name: "background", arguments: "{}", async: true };
  let count = 0;
  const model: Model = {
    id: "one-turn", asyncTools: true,
    async *generate() {
      count += 1;
      if (count === 1) {
        yield { type: "tool-call.done", call: asyncCall };
        return ok({ message: { content: "", calls: [asyncCall] }, finishReason: "tool-calls", usage: {} });
      }
      return ok({ message: { content: "done" }, finishReason: "stop", usage: {} });
    },
  };
  const background = defineTool({
    name: "background", description: "background", schema: z.object({}), async: true,
    execute: () => ({ content: "done" }),
  });
  const result = await runAgent({
    agent: agentWith(model, { tools: [background], limits: { maxTurns: 1 } }), input: "start",
  }).result;
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.message).toBe("Stopped after 1 turns.");
  expect(count).toBe(1);
});

test("a provider cannot launch a tool asynchronously unless the tool declares it too", async () => {
  const trace: string[] = [];
  const requested = { callId: "c1", name: "background", arguments: "{}", async: true };
  let count = 0;
  const model: Model = {
    id: "async-model", asyncTools: true,
    async *generate() {
      count += 1;
      if (count === 1) {
        yield { type: "tool-call.done", call: requested };
        trace.push("model-finished");
        return ok({ message: { content: "", calls: [requested] }, finishReason: "tool-calls", usage: {} });
      }
      return ok({ message: { content: "done" }, finishReason: "stop", usage: {} });
    },
  };
  const synchronous = defineTool({
    name: "background", description: "background", schema: z.object({}),
    execute: () => { trace.push("tool-started"); return { content: "done" }; },
  });
  const result = await runAgent({ agent: agentWith(model, { tools: [synchronous] }), input: "start" }).result;
  expect(result.status).toBe("completed");
  expect(trace).toEqual(["model-finished", "tool-started"]);
});

test("turn input arriving during a terminal generation is read before the activation ends", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({ sessionId: "peer", agent: { id: "a", version: "1" } });
  let count = 0;
  const model: Model = {
    id: "terminal-input",
    async *generate(request) {
      count += 1;
      if (count === 1) {
        const sent = await store.append({ sessionId: "peer", expectedSeq: 0, entries: [], enqueue: [
          { sessionId: "s", input: "Correction: Friday", priority: "turn" },
        ] });
        if (!sent.ok) throw new Error(sent.error.message);
        return ok({ message: { content: "Thursday" }, finishReason: "stop", usage: {} });
      }
      expect(JSON.stringify(request.messages)).toContain("Correction: Friday");
      return ok({ message: { content: "Friday" }, finishReason: "stop", usage: {} });
    },
  };
  const result = await runAgent({ agent: agentWith(model), store, sessionId: "s", input: "Which day?" }).result;
  expect(result.status).toBe("completed");
  if (result.status === "completed") expect(textOf(result.output)).toBe("Friday");
});

test("turn input can steer a generation that explicitly supports it", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({ sessionId: "peer", agent: { id: "a", version: "1" } });
  let release!: () => void;
  const steered = new Promise<void>((resolve) => { release = resolve; });
  const seen: string[] = [];
  let generations = 0;
  const model: Model = {
    id: "steerable",
    generate() {
      generations += 1;
      const iterator = (async function*() {
        yield { type: "text.delta" as const, text: "checking" };
        await steered;
        return ok({ message: { content: "Friday" }, finishReason: "stop" as const, usage: {} });
      })();
      return Object.assign(iterator, {
        steer: async (messages: readonly Message[]) => {
          seen.push(JSON.stringify(messages));
          release();
          return { status: "accepted" as const, id: "successor" };
        },
      });
    },
  };
  const run = runAgent({ agent: agentWith(model), store, sessionId: "s", input: "Which day?" });
  const deliver = (async () => {
    for await (const update of run) {
      if (update.type !== "text.delta") continue;
      const sent = await store.append({ sessionId: "peer", expectedSeq: 0, entries: [], enqueue: [
        { sessionId: "s", input: "Correction: Friday", priority: "turn" },
      ] });
      if (!sent.ok) throw new Error(sent.error.message);
      return;
    }
  })();
  const [result] = await Promise.all([run.result, deliver]);
  expect(result.status).toBe("completed");
  expect(generations).toBe(1);
  expect(seen.join()).toContain("Correction: Friday");
});

test("rejected steering finishes the current generation and retries durable input at the next boundary", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({ sessionId: "peer", agent: { id: "a", version: "1" } });
  let release!: () => void;
  const attempted = new Promise<void>((resolve) => { release = resolve; });
  let generations = 0;
  const model: Model = {
    id: "rejecting-steer",
    generate(request) {
      generations += 1;
      if (generations === 2) {
        expect(JSON.stringify(request.messages)).toContain("Correction: Friday");
        return (async function*() {
          return ok({ message: { content: "Friday" }, finishReason: "stop" as const, usage: {} });
        })();
      }
      const iterator = (async function*() {
        yield { type: "text.delta" as const, text: "checking" };
        await attempted;
        return ok({ message: { content: "Thursday" }, finishReason: "stop" as const, usage: {} });
      })();
      return Object.assign(iterator, {
        steer: async () => {
          release();
          return { status: "rejected" as const, error: { code: "failed" as const, message: "not steerable", retryable: true } };
        },
      });
    },
  };
  const run = runAgent({ agent: agentWith(model), store, sessionId: "s", input: "Which day?" });
  const deliver = (async () => {
    for await (const update of run) {
      if (update.type !== "text.delta") continue;
      const sent = await store.append({ sessionId: "peer", expectedSeq: 0, entries: [], enqueue: [
        { sessionId: "s", input: "Correction: Friday", priority: "turn" },
      ] });
      if (!sent.ok) throw new Error(sent.error.message);
      return;
    }
  })();
  const [result] = await Promise.all([run.result, deliver]);
  expect(result.status).toBe("completed");
  if (result.status === "completed") expect(textOf(result.output)).toBe("Friday");
  expect(generations).toBe(2);
});

test("turn context is evaluated again for every model request", async () => {
  let current = "first clock";
  let count = 0;
  const seen: string[] = [];
  const model: Model = {
    id: "dynamic-context",
    async *generate(request) {
      seen.push(String(request.messages.at(-1)?.content));
      count += 1;
      if (count === 1) {
        current = "second clock";
        return ok({ message: { content: "", calls: [call] }, finishReason: "tool-calls", usage: {} });
      }
      return ok({ message: { content: "done" }, finishReason: "stop", usage: {} });
    },
  };
  const result = await runAgent({ agent: agentWith(model), input: "time?", context: { turn: () => current } }).result;
  expect(result.status).toBe("completed");
  expect(seen).toEqual(["first clock", "second clock"]);
});

test("a model failure ends the run typed, with the outcome on the log", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  const result = await runAgent({
    agent: agentWith(createFakeModel([])), store, sessionId: "s", input: "hi",
  }).result;
  expect(result.status).toBe("failed");
  const read = await store.read({ sessionId: "s" });
  if (!read.ok) throw new Error("read failed");
  const last = read.value.entries.at(-1);
  expect(last?.type).toBe("run.finished");
  expect(last?.type === "run.finished" && last.outcome).toBe("failed");
});

test("a tool's delivery to another session commits with the run that made it", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({ sessionId: "child", agent: { id: "a", version: "1" } });
  const notify = defineTool({
    name: "notify", description: "notify", schema: z.object({ text: z.string() }),
    execute: ({ text }, context) => {
      context.enqueue({ sessionId: "child", input: text });
      return { content: "sent" };
    },
  });
  const result = await runAgent({
    agent: agentWith(
      createFakeModel([
        { calls: [{ callId: "c1", name: "notify", arguments: JSON.stringify({ text: "go" }) }] },
        { text: "done" },
      ]),
      { tools: [notify] },
    ),
    store, sessionId: "parent", input: "tell the child",
  }).result;
  expect(result.status).toBe("completed");

  const runnable = await store.next({});
  if (!runnable.ok || !runnable.value) throw new Error("expected a delivery");
  expect(runnable.value.sessionId).toBe("child");
  // The sender is stamped by the executor, not stated by the tool: `notify`
  // above never said who it was, and a recipient can still tell.
  expect(runnable.value.pending).toEqual([
    { sessionId: "child", input: "go", from: { kind: "session", id: "parent" } },
  ]);
});

test("one tool's result and deliveries commit before a slower concurrent call finishes", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({ sessionId: "fast-child", agent: { id: "a", version: "1" } });
  await store.create({ sessionId: "slow-child", agent: { id: "a", version: "1" } });
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  let fastCommitted!: () => void;
  const fastGate = new Promise<void>((resolve) => { fastCommitted = resolve; });
  const send = defineTool({
    name: "send", description: "send", schema: z.object({ target: z.string() }),
    annotations: { readOnly: true },
    execute: async ({ target }, context) => {
      context.enqueue({ sessionId: target, input: target });
      if (target === "slow-child") await slowGate;
      else fastCommitted();
      return { content: target };
    },
  });
  const calls = [
    { callId: "slow", name: "send", arguments: JSON.stringify({ target: "slow-child" }) },
    { callId: "fast", name: "send", arguments: JSON.stringify({ target: "fast-child" }) },
  ];
  const run = runAgent({
    agent: agentWith(createFakeModel([{ calls }, { text: "done" }]), { tools: [send] }),
    store, sessionId: "parent", input: "send both",
  });
  await fastGate;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const fast = await store.read({ sessionId: "fast-child" });
  const slow = await store.read({ sessionId: "slow-child" });
  expect(fast.ok && fast.value.pending.map((delivery) => delivery.input)).toEqual(["fast-child"]);
  expect(slow.ok && slow.value.pending).toEqual([]);
  releaseSlow();
  expect((await run.result).status).toBe("completed");
});

test("a declared turn limit stops the run and says so", async () => {
  // The ceiling lives in runAgent, not in a harness, so it holds for a harness
  // that owns its own loop too. Before, it was declared and enforced nowhere.
  const model = createFakeModel([
      { calls: [{ callId: "c1", name: "read_ledger", arguments: "{}" }] },
      { calls: [{ callId: "c2", name: "read_ledger", arguments: "{}" }] },
      { calls: [{ callId: "c3", name: "read_ledger", arguments: "{}" }] },
      { text: "done" },
  ]);
  const run = runAgent({
    agent: agentWith(model, { limits: { maxTurns: 2 } }),
    input: "What is the balance?",
  });
  const result = await run.result;

  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.code).toBe("turn-limit");
});

test("a tool-call ceiling is enforced the same way", async () => {
  const model = createFakeModel([
      { calls: [{ callId: "c1", name: "read_ledger", arguments: "{}" }] },
      { calls: [{ callId: "c2", name: "read_ledger", arguments: "{}" }] },
      { text: "done" },
  ]);
  const run = runAgent({
    agent: agentWith(model, { limits: { maxToolCalls: 1 } }),
    input: "What is the balance?",
  });
  const result = await run.result;

  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.error.code).toBe("tool-call-limit");
});

test("one multi-part message is one arrival, not one per part", async () => {
  const model = createFakeModel([{ text: "seen" }]);
  const run = runAgent({
    agent: agentWith(model),
    input: [{ type: "text", text: "what is this?" }, { type: "text", text: "and this?" }],
  });
  const started: unknown[] = [];
  for await (const update of run) {
    if (update.type === "entry" && update.entry.type === "run.started") started.push(update.entry.input);
  }
  await run.result;

  expect(started).toHaveLength(1);
  expect(started[0]).toEqual([{ type: "text", text: "what is this?" }, { type: "text", text: "and this?" }]);
});

test("running a different agent version over an existing session is refused", async () => {
  const database = new Database(":memory:");
  const store = createSqliteStore({ database });
  const model = createFakeModel([{ text: "one" }, { text: "two" }]);

  await runAgent({ agent: agentWith(model), store, sessionId: "s", input: "first" }).result;
  const second = await runAgent({
    agent: { ...agentWith(model), version: "2" }, store, sessionId: "s", input: "second",
  }).result;

  expect(second.status).toBe("failed");
  if (second.status === "failed") expect(second.error.code).toBe("conflict");
});

test("two listeners on one run both see everything", async () => {
  // Telemetry and a UI can watch the same run. They used to steal from each other.
  const model = createFakeModel([{ text: "hello" }]);
  const run = runAgent({ agent: agentWith(model), input: "hi" });

  const drain = async () => {
    const seen: string[] = [];
    for await (const update of run) if (update.type === "entry") seen.push(update.entry.type);
    return seen;
  };
  const [first, second] = await Promise.all([drain(), drain(), run.result]);

  expect(first).toEqual(["run.started", "assistant", "run.finished"]);
  expect(second).toEqual(first);
});

test("an assistant turn records which model answered and the span it took", async () => {
  const model = createFakeModel([{ text: "hello" }]);
  const run = runAgent({ agent: agentWith(model), input: "hi" });
  const assistants: { generation?: { model?: string; startedAt: string; endedAt: string } }[] = [];
  for await (const update of run) {
    if (update.type === "entry" && update.entry.type === "assistant") assistants.push(update.entry);
  }
  await run.result;

  const generation = assistants[0]?.generation;
  expect(generation).toBeDefined();
  expect(Date.parse(generation!.endedAt)).toBeGreaterThanOrEqual(Date.parse(generation!.startedAt));
});

test("a message arriving mid-activation is folded in without ending the turn", async () => {
  // `priority: "turn"`: the message reaches an activation already running, at
  // the one boundary where nothing is half-done, and the turn keeps its work.
  const database = new Database(":memory:");
  const store = createSqliteStore({ database });
  const model = createFakeModel([
    { calls: [{ callId: "c1", name: "read_ledger", arguments: "{}" }] },
    { text: "done" },
  ]);

  const delivering = defineTool({
    name: "read_ledger", description: "read", annotations: { readOnly: true },
    schema: z.object({}),
    execute: async () => {
      // A peer messages this session while its activation is running — the
      // sender writes from its own position, which is the real shape.
      await store.create({ sessionId: "peer", agent: { id: "a", version: "1" } });
      const sent = await store.append({
        sessionId: "peer", expectedSeq: 0, entries: [],
        enqueue: [{ sessionId: "s", input: "stop, use last year's ledger", from: { kind: "session", id: "peer" }, priority: "turn" }],
      });
      if (!sent.ok) throw new Error(`enqueue failed: ${sent.error.message}`);
      return { content: "1250" };
    },
  });

  const run = runAgent({
    agent: { ...agentWith(model), tools: [delivering] },
    store, sessionId: "s", input: "What is the balance?",
  });
  const result = await run.result;
  expect(result.status).toBe("completed");

  const after = await store.read({ sessionId: "s" });
  if (!after.ok) throw new Error("read failed");

  // Folded into the same activation, and taken off the queue by the write.
  const inputs = after.value.entries.filter((entry) => entry.type === "run.started");
  expect(inputs).toHaveLength(2);
  expect(after.value.pending).toEqual([]);

  // One activation throughout: the turn was never ended to deliver it.
  expect(after.value.entries.filter((entry) => entry.type === "run.finished")).toHaveLength(1);
});

test("a run that keeps calling tools folds without waiting to end", async () => {
  // The shape that could not compact: inside one activation every assistant turn
  // holds calls until the one that ends the run, so the only log big enough to
  // need folding was the log with nowhere to cut, and it grew until the provider
  // refused it.
  const store = createSqliteStore({ database: new Database(":memory:") });
  const bulky = defineTool({
    name: "read_ledger", description: "read", annotations: { readOnly: true },
    schema: z.object({}),
    execute: () => ({ content: "1250 ".repeat(400) }),
  });
  const model = createFakeModel([
    ...Array.from({ length: 10 }, (_, index) => ({
      calls: [{ callId: `c${index}`, name: "read_ledger", arguments: "{}" }],
    })),
    { text: "The balance is 1250." },
  ]);
  const summariser = createFakeModel(Array.from({ length: 10 }, () => ({ text: "It read the ledger repeatedly." })));

  const result = await runAgent({
    agent: agentWith(model, {
      tools: [bulky],
      hooks: [createCompactionHook({ maxInputTokens: 2_000, model: summariser })],
    }),
    store, sessionId: "s", input: "audit the ledger",
  }).result;
  expect(result.status).toBe("completed");

  const read = await store.read({ sessionId: "s" });
  if (!read.ok) throw new Error("read failed");
  const summaries = read.value.entries.filter((entry) => entry.type === "summary");
  expect(summaries.length).toBeGreaterThan(0);
  // Folded inside the activation, which ran to its own end rather than being cut
  // short — and the fold landed where a batch had been answered in full.
  expect(read.value.entries.filter((entry) => entry.type === "run.finished")).toHaveLength(1);
  const first = summaries[0];
  const replaces = first?.type === "summary" ? first.replaces : 0;
  expect(read.value.entries.find((entry) => entry.seq === replaces)?.type).toBe("tool.finished");
});

// ---- What a run consumed ---------------------------------------------------

const priced = { inputTokens: 1_000, outputTokens: 100 };

test("what a run consumed leaves it, whatever ended it", async () => {
  // A run that burned a thousand tokens and then failed burned them. Reporting
  // usage only on the way out of a completed run hid the expensive half.
  const model = createFakeModel([
    { calls: [{ callId: "c1", name: "read_ledger", arguments: "{}" }], usage: priced },
  ]);
  const result = await runAgent({ agent: agentWith(model), input: "balance?" }).result;
  expect(result.status).toBe("failed");
  expect(result.usage).toEqual({ inputTokens: 1_000, outputTokens: 100 });
});

test("counts add across turns, and unknown stays unknown", async () => {
  const model = createFakeModel([
    { calls: [{ callId: "c1", name: "read_ledger", arguments: "{}" }], usage: priced },
    { text: "1250", usage: { inputTokens: 2_000 } },
  ]);
  const result = await runAgent({ agent: agentWith(model), input: "balance?" }).result;
  expect(result.status).toBe("completed");
  // Nothing reported an output count for the second turn, so the total is the
  // first turn's and not a zero standing in for what nobody said.
  expect(result.usage).toEqual({ inputTokens: 3_000, outputTokens: 100 });
});

test("a run whose commit loses the race still says what it burned", async () => {
  // The tokens were consumed whether or not the entry carrying them landed, so
  // counting happens before the write rather than after it.
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({ sessionId: "s", agent: { id: "a", version: "1" } });
  const stealing = defineTool({
    name: "read_ledger", description: "read", schema: z.object({}),
    execute: async () => {
      // Somebody else advances the session mid-activation, so this run's next
      // commit is refused.
      const read = await store.read({ sessionId: "s" });
      if (!read.ok) throw new Error("read failed");
      await store.append({
        sessionId: "s", expectedSeq: read.value.seq,
        entries: [{ type: "assistant", runId: "elsewhere", content: "" }],
      });
      return { content: "1250" };
    },
  });
  const model = createFakeModel([
    { calls: [{ callId: "c1", name: "read_ledger", arguments: "{}" }], usage: priced },
    { text: "never committed", usage: priced },
  ]);
  const result = await runAgent({
    agent: agentWith(model, { tools: [stealing] }), store, sessionId: "s", input: "balance?",
  }).result;
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.error.code).toBe("conflict");
  expect(result.usage.inputTokens).toBe(1_000);
});

// ---- Resuming a committed log ---------------------------------------------

test("an activation with no input continues the interrupted run, under its own id", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  let ran = 0;
  const effect = defineTool({
    name: "read_ledger", description: "read", schema: z.object({}),
    execute: () => { ran += 1; return { content: "1250" }; },
  });

  // The state a killed worker leaves: everything up to a committed tool result,
  // and no terminal entry.
  await store.create({ sessionId: "s", agent: { id: "a", version: "1" } });
  await store.append({
    sessionId: "s", expectedSeq: 0,
    entries: [
      { type: "run.started", runId: "interrupted", input: "balance?" },
      { type: "assistant", runId: "interrupted", content: "", calls: [call] },
      { type: "tool.started", runId: "interrupted", callId: "c1" },
      { type: "tool.finished", runId: "interrupted", callId: "c1", result: { content: "1250" } },
    ],
  });

  const seen: (readonly { role: string; content: unknown }[])[] = [];
  const watching: Model = {
    id: "watching",
    async *generate(request) {
      seen.push(request.messages);
      return ok({ message: { content: "The balance is 1250." }, finishReason: "stop", usage: {} });
    },
  };

  const result = await runAgent({
    agent: agentWith(watching, { tools: [effect] }),
    store, claim: { sessionId: "s", seq: 4, pending: [], metadata: {} },
  }).result;
  expect(result.status).toBe("completed");

  // It read the history it was handed: the question, and the answer the tool
  // already gave. So the model is never asked for that call again.
  const asked = JSON.stringify(seen[0]);
  expect(asked).toContain("balance?");
  expect(asked).toContain("1250");
  expect(ran).toBe(0);

  const after = await store.read({ sessionId: "s" });
  if (!after.ok) throw new Error("read failed");
  // One beginning, not two — and the run that ends is the run that began.
  expect(after.value.entries.filter((entry) => entry.type === "run.started")).toHaveLength(1);
  const last = after.value.entries.at(-1);
  expect(last?.type === "run.finished" && last.runId).toBe("interrupted");
});

test("a claim with nothing open has nothing to continue", async () => {
  // A closed log would otherwise take a second `run.finished` with no beginning
  // to match it.
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({ sessionId: "s", agent: { id: "a", version: "1" } });
  await store.append({
    sessionId: "s", expectedSeq: 0,
    entries: [
      { type: "run.started", runId: "r", input: "hi" },
      { type: "run.finished", runId: "r", outcome: "completed" },
    ],
  });
  const result = await runAgent({
    agent: agentWith(createFakeModel([])),
    store, claim: { sessionId: "s", seq: 2, pending: [], metadata: {} },
  }).result;
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.error.code).toBe("nothing-to-resume");
});

test("beginning over an interrupted run ends it, so a session never holds two", async () => {
  // The reachable shape: `store.interrupted` hands back a session with an
  // empty queue, and the worker adds input of its own — which is a beginning,
  // not a resumption. `next` cannot produce this, because it skips a session
  // with an open activation.
  const store = createSqliteStore({ database: new Database(":memory:"), claimMs: 30 });
  await store.create({ sessionId: "s", agent: { id: "a", version: "1" } });
  await store.append({
    sessionId: "s", expectedSeq: 0,
    entries: [{ type: "run.started", runId: "interrupted", input: "the old question" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const claimed = await store.interrupted({});
  if (!claimed.ok || !claimed.value) throw new Error("expected a claim");

  const result = await runAgent({
    agent: agentWith(createFakeModel([{ text: "answered" }])),
    store, claim: claimed.value, input: "the new one",
  }).result;
  expect(result.status).toBe("completed");

  const after = await store.read({ sessionId: "s" });
  if (!after.ok) throw new Error("read failed");
  const finished = after.value.entries.filter((entry) => entry.type === "run.finished");
  // The predecessor is closed as cancelled, not failed: nothing went wrong with
  // it, it was cut short and something else took over.
  expect(finished.map((entry) => entry.type === "run.finished" && entry.outcome)).toEqual(["cancelled", "completed"]);
  expect(finished[0]?.type === "run.finished" && finished[0].runId).toBe("interrupted");
});

test("a harness that cannot restart from history ends the run rather than leaving it open", async () => {
  // The trap this closes: a refusal that wrote nothing left the activation
  // open, so `interrupted` handed the session back every claim window — and a
  // worker that provisions a sandbox before it runs paid for one each time,
  // for ever.
  const store = createSqliteStore({ database: new Database(":memory:"), claimMs: 30 });
  const forgetful = { ...createNativeHarness({ model: createFakeModel([]) }), id: "forgetful", recovery: "none" as const };
  await store.create({ sessionId: "s", agent: { id: "a", version: "1" } });
  await store.create({ sessionId: "opener", agent: { id: "a", version: "1" } });
  await store.append({ sessionId: "s", expectedSeq: 0, entries: [{ type: "run.started", runId: "r", input: "hi" }] });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const found = await store.interrupted({});
  if (!found.ok || !found.value) throw new Error("expected an interrupted activation");

  const result = await runAgent({
    agent: {
      ...agentWith(createFakeModel([])), harness: forgetful,
      hooks: [{ name: "report", beforeStop: (_, result) => ({ deliveries: [{ sessionId: "opener", input: `child ${result.status}`, from: { kind: "session", id: "s" } }] }) }],
    },
    store, claim: found.value,
  }).result;
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.error.code).toBe("no-recovery");

  // The interrupted run is closed, so nothing is handed back a second time.
  const after = await store.read({ sessionId: "s" });
  if (!after.ok) throw new Error("read failed");
  const last = after.value.entries.at(-1);
  expect(last?.type === "run.finished" && last.runId).toBe("r");
  expect((await store.interrupted({})).ok && (await store.interrupted({})).value).toBeUndefined();

  // And whoever was waiting on it is told, rather than waiting for ever.
  const opener = await store.read({ sessionId: "opener" });
  expect(opener.ok && opener.value.pending.map((delivery) => delivery.input)).toEqual(["child failed"]);
});

test("there is nothing to continue in a session that has said nothing", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({ sessionId: "s", agent: { id: "a", version: "1" } });
  const result = await runAgent({
    agent: agentWith(createFakeModel([])),
    store, claim: { sessionId: "s", seq: 0, pending: [], metadata: {} },
  }).result;
  expect(result.status).toBe("failed");
  if (result.status !== "failed") return;
  expect(result.error.code).toBe("nothing-to-resume");
});

test("a session whose worker died is found and finished", async () => {
  // The whole resumption path in one place: the state a killed process leaves,
  // the question that finds it, and the activation that continues rather than
  // begins. `next` cannot see this session — nothing is owed to it, and it is
  // already running as far as the store knows.
  const store = createSqliteStore({ database: new Database(":memory:"), claimMs: 30 });
  await store.create({ sessionId: "s", agent: { id: "a", version: "1" } });
  await store.append({
    sessionId: "s", expectedSeq: 0,
    entries: [
      { type: "run.started", runId: "r", input: "balance?" },
      { type: "assistant", runId: "r", content: "", calls: [call] },
      { type: "tool.started", runId: "r", callId: "c1" },
      { type: "tool.finished", runId: "r", callId: "c1", result: { content: "1250" } },
    ],
  });

  expect((await store.next({})).ok && (await store.next({})).value).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 60));

  const found = await store.interrupted({});
  if (!found.ok || !found.value) throw new Error("expected an interrupted activation");
  expect(found.value.sessionId).toBe("s");

  // Straight from the store to the run: nothing to line up by hand.
  const result = await runAgent({
    agent: agentWith(createFakeModel([{ text: "The balance is 1250." }])),
    store, claim: found.value,
  }).result;
  expect(result.status).toBe("completed");

  const after = await store.read({ sessionId: "s" });
  if (!after.ok) throw new Error("read failed");
  expect(after.value.entries.filter((entry) => entry.type === "run.started")).toHaveLength(1);
  expect(after.value.entries.at(-1)?.type).toBe("run.finished");
  // Finished, so there is nothing left interrupted.
  expect((await store.interrupted({})).ok && (await store.interrupted({})).value).toBeUndefined();
});

test("a claim's queue is consumed by the run that commits it", async () => {
  // The wiring both applications wrote by hand, and the one that lost data when
  // it was forgotten: the deliveries a worker was handed are removed by the
  // write that records them as entries, and nothing else is.
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({ sessionId: "s", agent: { id: "a", version: "1" } });
  await store.append({
    sessionId: "s", expectedSeq: 0, entries: [],
    enqueue: [{ sessionId: "s", input: "balance?", from: { kind: "session", id: "peer" } }],
  });
  const claimed = await store.next({});
  if (!claimed.ok || !claimed.value) throw new Error("expected a claim");

  // Something arrives after the claim was read.
  await store.append({ sessionId: "s", expectedSeq: 0, entries: [], enqueue: [{ sessionId: "s", input: "and this" }] });

  const result = await runAgent({
    agent: agentWith(createFakeModel([{ text: "1250" }])),
    store, claim: claimed.value,
  }).result;
  expect(result.status).toBe("completed");

  const after = await store.read({ sessionId: "s" });
  if (!after.ok) throw new Error("read failed");
  // What it was handed is gone; what arrived since is still owed.
  expect(after.value.pending.map((delivery) => delivery.input)).toEqual(["and this"]);
  // And the provenance the claim carried reached the log.
  const opened = after.value.entries.find((entry) => entry.type === "run.started");
  expect(opened?.type === "run.started" && opened.from).toEqual({ kind: "session", id: "peer" });
});
