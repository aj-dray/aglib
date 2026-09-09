import { expect, test } from "bun:test";
import { compactionCut, createCompactionHook, summarize } from "./compaction.js";
import { toMessages } from "../../../session/messages.js";
import type { Entry, Stored } from "../../../session/entry.js";
import { createLog } from "../../../session/log.js";
import { createFakeModel } from "../../../model/adapters/fake/index.js";
import type { Model, ModelRequest } from "../../../model/model.js";
import type { HarnessContext } from "../../harness.js";

const log = (...entries: Entry[]): Stored[] =>
  entries.map((entry, index) => ({ ...entry, seq: index + 1, at: "2026-01-01T00:00:00.000Z" }));

/** One activation that has not stopped: a batch of calls, its results, again. */
function activation(batches: number): Stored[] {
  const entries: Entry[] = [{ type: "run.started", runId: "r", input: "audit the ledger" }];
  for (let batch = 0; batch < batches; batch += 1) {
    const calls = [
      { callId: `${batch}a`, name: "read_ledger", arguments: "{}" },
      { callId: `${batch}b`, name: "read_ledger", arguments: "{}" },
    ];
    entries.push({ type: "assistant", runId: "r", content: "", calls });
    for (const call of calls) entries.push({ type: "tool.started", runId: "r", callId: call.callId });
    for (const call of calls) {
      entries.push({ type: "tool.finished", runId: "r", callId: call.callId, result: { content: "1250" } });
    }
  }
  return log(...entries);
}

test("a long run has a boundary before it ends", () => {
  const entries = activation(50);
  // Nothing is finished and every turn asked for something — which is the whole
  // log of any run long enough to need folding, and used to be the one shape
  // with nowhere to cut.
  expect(entries.some((entry) => entry.type === "run.finished")).toBe(false);
  const cut = compactionCut(entries, 200);
  expect(cut).toBeDefined();
  // Between two batches, so the tail the fold keeps verbatim is still there.
  expect(cut!).toBeGreaterThan(0);
  expect(cut!).toBeLessThan(entries.length);
  expect(entries[cut! - 1]?.type).toBe("tool.finished");
});

test("a call and its result never straddle the cut", () => {
  let retainedResults = 0;
  for (const batches of [1, 2, 3, 9, 40]) {
    const entries = activation(batches);
    const cut = compactionCut(entries, 200);
    if (cut === undefined) continue;
    const folded: Stored[] = [
      ...entries,
      { type: "summary", runId: "r", content: "earlier", replaces: cut, seq: entries.length + 1, at: "" },
    ];

    const asked = new Set<string>();
    for (const message of toMessages({ instructions: "i", entries: folded })) {
      if (message.role === "assistant") for (const call of message.calls ?? []) asked.add(call.callId);
      // A result for a call the model can no longer see is what the rule exists
      // to prevent, and what a provider rejects the request for.
      if (message.role === "tool") {
        expect(asked.has(message.callId)).toBe(true);
        retainedResults += 1;
      }
    }
  }
  expect(retainedResults).toBeGreaterThan(0);
});

test("a call nothing answered does not cost the session every later boundary", () => {
  const entries = log(
    { type: "run.started", runId: "first", input: "go" },
    { type: "assistant", runId: "first", content: "", calls: [{ callId: "c1", name: "read_ledger", arguments: "{}" }] },
    { type: "tool.started", runId: "first", callId: "c1" },
    { type: "run.finished", runId: "first", outcome: "cancelled" },
    { type: "run.started", runId: "second", input: "again" },
    { type: "assistant", runId: "second", content: "", calls: [{ callId: "c2", name: "read_ledger", arguments: "{}" }] },
    { type: "tool.started", runId: "second", callId: "c2" },
    { type: "tool.finished", runId: "second", callId: "c2", result: { content: "1250" } },
    { type: "assistant", runId: "second", content: "1250" },
    { type: "run.finished", runId: "second", outcome: "completed" },
  );
  // The killed activation's call is never answered, and awaiting it for ever
  // would leave this session with no boundary past seq 1 for the rest of its
  // life. The projection closes that call beside the turn that made it, so the
  // run's end drains what it was holding and the next arrival is a boundary.
  expect(compactionCut(entries, 40)).toBeGreaterThanOrEqual(4);
});

function contextFor(entries: Stored[]): HarnessContext {
  const session = createLog(entries);
  return {
    sessionId: "s", runId: "r", instructions: "i",
    entries: () => session.entries,
    history: () => toMessages({ instructions: "i", entries: session.entries }),
    commit: async entries => { session.append(entries); },
    emit: () => {},
    signal: new AbortController().signal,
  };
}

function recording(model: Model) {
  const requests: ModelRequest[] = [];
  return {
    requests,
    model: {
      id: model.id,
      async *generate(request: ModelRequest) {
        requests.push(request);
        return yield* model.generate(request);
      },
    } satisfies Model,
  };
}

const largeExchange = () => log(
  { type: "run.started", runId: "r", input: "read the report" },
  { type: "assistant", runId: "r", content: "", calls: [{ callId: "c", name: "read", arguments: '{"path":"/reports/source.txt"}' }] },
  { type: "tool.finished", runId: "r", callId: "c", result: { content: "source evidence ".repeat(400) } },
  { type: "run.started", runId: "r", input: "Now research the company instead." },
);

test("a single huge tool exchange can fold without swallowing the latest correction", async () => {
  const context = contextFor(largeExchange());
  const hook = createCompactionHook({ maxInputTokens: 300, model: createFakeModel([{ text: "Report read; company research remains." }]) });
  expect(await hook.beforeModel!(context)).toBeUndefined();
  expect(context.entries().at(-1)).toMatchObject({ type: "summary", replaces: 3 });
  expect(context.history().map(message => message.content)).toEqual([
    "i", "<summary>\nReport read; company research remains.\n</summary>", "Now research the company instead.",
  ]);
});

test("the summarizer receives tool names, arguments, matched results and failure status", async () => {
  const captured = recording(createFakeModel([{ text: "Note delivered, company save failed." }]));
  const entries = log(
    { type: "assistant", runId: "r", content: "", calls: [
      { callId: "send-1", name: "send", arguments: '{"recipient":"owner","message":"interim note"}' },
      { callId: "write-1", name: "company.write", arguments: '{"name":"Nox Services"}' },
    ] },
    { type: "tool.finished", runId: "r", callId: "send-1", result: { content: "Delivered msg-123." } },
    { type: "tool.finished", runId: "r", callId: "write-1", result: { content: "No record saved.", isError: true } },
  );
  expect((await summarize({ model: captured.model, messages: toMessages({ instructions: "i", entries }) })).ok).toBe(true);
  const prompt = String(captured.requests[0]?.messages[0]?.content);
  const transcript = prompt.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  expect(transcript).toContainEqual({ role: "assistant", content: "", calls: entries[0]?.type === "assistant" ? entries[0].calls : [] });
  expect(transcript).toContainEqual({ role: "tool", content: "Delivered msg-123.", callId: "send-1" });
  expect(transcript).toContainEqual({ role: "tool", content: "No record saved.", callId: "write-1", isError: true });
});

test.each([
  { name: "empty", response: { text: "" } },
  { name: "whitespace", response: { text: "  \n " } },
  { name: "truncated", response: { text: "An incomplete checkpoint", finishReason: "length" as const } },
  { name: "refused", response: { text: "Cannot summarize", finishReason: "refusal" as const } },
  { name: "tool call", response: { text: "I will continue", calls: [{ callId: "unexpected", name: "send", arguments: "{}" }] } },
  { name: "nonshrinking", response: { text: "larger checkpoint ".repeat(500) } },
  { name: "still over budget", response: { text: "smaller but oversized ".repeat(100) } },
])("$name summary fails without committing or changing history", async ({ response }) => {
  const context = contextFor(largeExchange());
  const before = context.entries();
  const hook = createCompactionHook({ maxInputTokens: 300, model: createFakeModel([response]) });
  const failure = await hook.beforeModel!(context);
  expect(failure).toMatchObject({ retryable: false });
  expect(context.entries()).toEqual(before);
  expect(context.history()).toEqual(toMessages({ instructions: "i", entries: before }));
});

test("an unresolved tool batch fails without trying to summarize across its calls", async () => {
  const captured = recording(createFakeModel([]));
  const context = contextFor(log(
    { type: "assistant", runId: "r", content: "thinking ".repeat(1000), calls: [{ callId: "pending", name: "read", arguments: "{}" }] },
  ));
  const before = context.entries();
  expect(await createCompactionHook({ maxInputTokens: 300, model: captured.model }).beforeModel!(context))
    .toMatchObject({ code: "context-overflow" });
  expect(captured.requests).toHaveLength(0);
  expect(context.entries()).toEqual(before);
});

test("a repeated fold includes the prior checkpoint once and preserves newer input", async () => {
  const captured = recording(createFakeModel([{ text: "Original reference AZ-417; people research remains pending." }]));
  const context = contextFor(log(
    { type: "run.started", runId: "r", input: "original task AZ-417" },
    { type: "assistant", runId: "r", content: "original investigation" },
    { type: "run.started", runId: "r", input: "Research people instead." },
    { type: "summary", runId: "r", content: "Reference AZ-417; original digest unfinished.", replaces: 2 },
    { type: "assistant", runId: "r", content: "additional evidence ".repeat(400) },
    { type: "run.started", runId: "r", input: "Prioritize Nox Services now." },
  ));
  expect(await createCompactionHook({ maxInputTokens: 300, model: captured.model }).beforeModel!(context)).toBeUndefined();
  const prompt = String(captured.requests[0]?.messages[0]?.content);
  expect(prompt.match(/Reference AZ-417; original digest unfinished\./g)).toHaveLength(1);
  expect(prompt.indexOf("Reference AZ-417")).toBeLessThan(prompt.indexOf("Research people instead."));
  expect(prompt).not.toContain("Prioritize Nox Services now.");
  expect(context.history().map(message => message.content)).toEqual([
    "i", "<summary>\nOriginal reference AZ-417; people research remains pending.\n</summary>", "Prioritize Nox Services now.",
  ]);
});

test("provider input usage triggers compaction then resets after the checkpoint", async () => {
  const captured = recording(createFakeModel([{ text: "The report was read." }]));
  const context = contextFor(log(
    { type: "run.started", runId: "r", input: "inspect the report" },
    { type: "assistant", runId: "r", content: "evidence ".repeat(100), usage: { inputTokens: 400, cacheReadTokens: 400 } },
    { type: "run.started", runId: "r", input: "Continue." },
  ));
  const hook = createCompactionHook({ maxInputTokens: 500, model: captured.model });
  // The text estimate is below the threshold; the provider's disjoint fresh
  // and cached input counts establish that the actual request was larger.
  expect(await hook.beforeModel!(context)).toBeUndefined();
  expect(context.entries().at(-1)?.type).toBe("summary");
  expect(await hook.beforeModel!(context)).toBeUndefined();
  expect(captured.requests).toHaveLength(1);
});

test("a large screenshot reaches the next model turn intact instead of being compacted as base64 text", async () => {
  const captured = recording(createFakeModel([{ text: "should not summarize" }]));
  const image = { type: "image", mediaType: "image/png", source: { kind: "inline", data: "AAAA".repeat(1_000_000) } } as const;
  const context = contextFor(log(
    { type: "run.started", runId: "r", input: "Look at this screen and click its link." },
    { type: "assistant", runId: "r", content: "", calls: [{ callId: "screen", name: "read", arguments: "{}" }], usage: { inputTokens: 4000 } },
    { type: "tool.finished", runId: "r", callId: "screen", result: { content: [image] } },
  ));
  const hook = createCompactionHook({ maxInputTokens: 100_000, model: captured.model });
  expect(await hook.beforeModel!(context)).toBeUndefined();
  expect(captured.requests).toHaveLength(0);
  expect(context.entries().some(entry => entry.type === "summary")).toBe(false);
  expect(context.history().at(-1)).toMatchObject({ role: "tool", callId: "screen", content: [image] });
});
