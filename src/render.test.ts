import { expect, test } from "bun:test";
import { renderRun, type Sink } from "./render.js";
import type { AgentRun } from "./agent.js";
import type { Update } from "./harness/harness.js";
import type { Entry, Stored } from "./session/entry.js";
import type { RunResult } from "./agent.js";

/** A committed entry, at a position nothing here depends on. */
const at = (entry: Entry, seq = 1): Update => ({
  type: "entry",
  entry: { ...entry, seq, at: "2026-08-30T00:00:00.000Z" } as Stored,
});

/** Captures both channels apart, with a clock that advances a second a call. */
function harness(detail?: Sink["detail"]) {
  const answer: string[] = [];
  const status: string[] = [];
  let tick = 0;
  const sink: Sink = {
    write: (text) => answer.push(text),
    status: (line) => status.push(line),
    now: () => (tick += 1000),
    ...(detail ? { detail } : {}),
  };
  return { sink, answer, status, all: () => answer.join("") + status.join("") };
}

const completed = (): RunResult => ({ status: "completed", output: "x", usage: {}, seq: 4 });

/** A run that has already happened, so a case is exactly its updates and its outcome. */
const runOf = (updates: readonly Update[], result: RunResult = completed()): AgentRun => ({
  async *[Symbol.asyncIterator]() { for (const update of updates) yield update; },
  result: Promise.resolve(result),
  cancel: () => {},
});

test("the answer and the account of the run go to different channels", async () => {
  const { sink, answer, status } = harness();
  await renderRun(runOf([
    at({ type: "assistant", runId: "r", content: "", calls: [{ callId: "c1", name: "bash", arguments: '{"command":"ls"}' }] }),
    { type: "text.delta", text: "September closes at 1250." },
  ]), sink);

  // Redirecting the answer captures the answer, and not one word about tools.
  expect(answer.join("")).toBe("September closes at 1250.\n");
  expect(status.join("")).toContain("→ bash");
  expect(status.join("")).toContain("— completed");
});

test("an assistant entry prints its text only when nothing streamed it first", async () => {
  // Our loop and Pi stream tokens; the Claude Code SDK emits one delta per
  // whole message; a harness may emit none. All three have to render once.
  const streamed = harness();
  await renderRun(runOf([
    { type: "text.delta", text: "hello" },
    at({ type: "assistant", runId: "r", content: "hello" }),
  ]), streamed.sink);

  const silent = harness();
  await renderRun(runOf([at({ type: "assistant", runId: "r", content: "hello" })]), silent.sink);

  // Identical output from a harness that streamed it and one that did not.
  // That equality is the whole rule: every harness renders, none renders twice.
  expect(streamed.answer.join("")).toBe("hello\n");
  expect(silent.answer.join("")).toBe("hello\n");
});

test("a cancelled run shows what it was saying, and says it was cancelled", async () => {
  // The text is worth seeing — it is most of what debugging a run is. What
  // would mislead is leaving the outcome implicit, so it never is.
  const { sink, answer, status } = harness();
  await renderRun(
    runOf([{ type: "text.delta", text: "I will start by" }], { status: "cancelled", usage: { outputTokens: 6 }, seq: 2 }),
    sink,
  );

  expect(answer.join("")).toContain("I will start by");
  expect(status.join("")).toContain("— cancelled");
  expect(status.join("")).toContain("6 out");
});

test("a failure names its code, and is not mistaken for an answer", async () => {
  const { sink, status } = harness();
  await renderRun(runOf([], {
    status: "failed",
    error: { code: "provider", message: "no response for call 1", retryable: false },
    usage: {}, seq: 1,
  }), sink);
  expect(status.join("")).toContain("✗");
  expect(status.join("")).toContain("failed (provider)");
});

test("input that came from somewhere else is shown; input the caller passed is not", async () => {
  const { sink, status } = harness();
  await renderRun(runOf([
    at({ type: "run.started", runId: "r", input: "what the operator typed" }),
    at({ type: "run.started", runId: "r", input: "Subagent reports: 1250", from: { kind: "session", id: "9b41f0e2-aaaa" } }),
  ]), sink);

  expect(status.join("")).not.toContain("what the operator typed");
  expect(status.join("")).toContain("◦ from session 9b41f0e2 · Subagent reports: 1250");
});

test("a tool result says how long it took, and never volunteers its details", async () => {
  const { sink, status } = harness();
  await renderRun(runOf([
    at({ type: "assistant", runId: "r", content: "", calls: [{ callId: "c1", name: "bash", arguments: "{}" }] }),
    at({ type: "tool.started", runId: "r", callId: "c1" }),
    at({ type: "tool.finished", runId: "r", callId: "c1", result: { content: "1250", details: { token: "sk-secret" } } }),
  ]), sink);

  expect(status.join("")).toContain("✓");
  expect(status.join("")).toContain("bash · 1.0s · 1250");
  expect(status.join("")).not.toContain("sk-secret");
});

test("debug shows what normal withholds, because someone asked", async () => {
  const { sink, status } = harness("debug");
  await renderRun(runOf([
    { type: "reasoning.delta", text: "weighing two options" },
    { type: "tool-call.delta", callId: "c1abcdef99", arguments: '{"comm' },
    at({ type: "tool.finished", runId: "r", callId: "c1", result: { content: "ok", details: { exitCode: 0 } } }),
  ]), sink);

  const text = status.join("");
  expect(text).toContain("· thinking");
  expect(text).toContain("weighing two options");
  expect(text).toContain('{"comm');
  expect(text).toContain('"exitCode":0');
});

test("answer writes the message and nothing at all beside it", async () => {
  const { sink, answer, status } = harness("answer");
  await renderRun(runOf([
    at({ type: "assistant", runId: "r", content: "", calls: [{ callId: "c1", name: "bash", arguments: "{}" }] }),
    { type: "text.delta", text: "1250 GBP" },
  ]), sink);

  expect(answer.join("")).toBe("1250 GBP\n");
  expect(status).toEqual([]);
});

test("content the model cannot read is marked, not silently dropped", async () => {
  const { sink, answer } = harness();
  await renderRun(runOf([at({
    type: "assistant", runId: "r",
    content: [
      { type: "text", text: "Here is the chart." },
      { type: "image", mediaType: "image/png", source: { kind: "inline", data: "iVBOR" } },
    ],
  })]), sink);
  expect(answer.join("")).toContain("Here is the chart.");
  expect(answer.join("")).toContain("[image image/png]");
});

test("a compaction says where it cut", async () => {
  const { sink, status } = harness();
  await renderRun(runOf([at({ type: "summary", runId: "r", content: "…", replaces: 42 })]), sink);
  expect(status.join("")).toContain("compacted through seq 42");
});


test("a run nobody asked for has no answer channel", async () => {
  // A subagent's text is not the answer — the parent's is. So a labelled run
  // sends everything to status, prefixed, including what it says.
  const answer: string[] = [];
  const status: string[] = [];
  await renderRun(runOf([{ type: "text.delta", text: "294 lines" }]), {
    write: (text) => answer.push(text),
    status: (line) => status.push(line),
    label: "[8bc0]",
    now: () => 0,
  });

  expect(answer).toEqual([]);
  expect(status.join("")).toContain("[8bc0] 294 lines");
  expect(status.join("")).toContain("[8bc0] — completed");
});

test("a sink with nowhere to put the account drops it, rather than into the answer", () => {
  // `write` holds the answer and nothing else. Folding status into it would
  // break that promise for every caller who only wanted the answer and did not
  // think to say so.
  const answer: string[] = [];
  return renderRun(
    runOf([
      at({ type: "assistant", runId: "r", content: "", calls: [{ callId: "c1", name: "bash", arguments: "{}" }] }),
      { type: "text.delta", text: "1250" },
    ]),
    { write: (text) => answer.push(text), now: () => 0 },
  ).then(() => {
    expect(answer.join("")).toBe("1250\n");
  });
});

test("a harness that streams only part of its turn still shows all of it", () => {
  // The port does not promise that deltas concatenate to the entry, so this
  // does not assume it. A prefix is completed rather than counted as the whole.
  const { sink, answer } = harness();
  return renderRun(runOf([
    { type: "text.delta", text: "The balance " },
    at({ type: "assistant", runId: "r", content: "The balance is 1250." }),
  ]), sink).then(() => {
    expect(answer.join("")).toBe("The balance is 1250.\n");
  });
});

test("a harness that streams something other than its turn shows both, not neither", () => {
  // Repeating a reader's words is a smaller failure than dropping the half
  // nobody streamed, so a mismatch prints the committed entry whole.
  const { sink, answer } = harness();
  return renderRun(runOf([
    { type: "text.delta", text: "thinking out loud" },
    at({ type: "assistant", runId: "r", content: "1250." }),
  ]), sink).then(() => {
    expect(answer.join("")).toContain("thinking out loud");
    expect(answer.join("")).toContain("1250.");
  });
});
