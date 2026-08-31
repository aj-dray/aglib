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

test("messages shows the conversation and withholds the internal stream", async () => {
  const { sink, answer, status } = harness("minimal");
  await renderRun(runOf([
    at({ type: "run.started", runId: "r", input: "Subagent reports: 1250", from: { kind: "session", id: "9b41f0e2-aaaa" } }),
    at({ type: "assistant", runId: "r", content: "", calls: [{ callId: "c1", name: "bash", arguments: "{}" }] }),
    at({ type: "tool.started", runId: "r", callId: "c1" }),
    at({ type: "tool.finished", runId: "r", callId: "c1", result: { content: "1250" } }),
    at({ type: "assistant", runId: "r", content: "September closes at 1250." }),
  ]), sink);

  // A message arriving is the conversation happening, so it survives the level
  // that drops the account of the run.
  expect(status.join("")).toContain("◦ from session 9b41f0e2");
  expect(answer.join("")).toBe("September closes at 1250.\n");
  // The agent talking to its own tools is not.
  expect(status.join("")).not.toContain("bash");
  expect(status.join("")).not.toContain("✓");
});

test("a failed call is never behind a detail level", async () => {
  const { sink, status } = harness("minimal");
  await renderRun(runOf([
    at({ type: "assistant", runId: "r", content: "", calls: [{ callId: "c1", name: "bash", arguments: "{}" }] }),
    at({ type: "tool.finished", runId: "r", callId: "c1", result: { content: "No suitable shell found", isError: true } }),
  ]), sink);

  // An agent that silently did nothing is the one outcome a reader cannot
  // diagnose from what they were shown.
  expect(status.join("")).toContain("✗");
  expect(status.join("")).toContain("No suitable shell found");
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

test("detailed shows what normal withholds, because someone asked", async () => {
  const { sink, status } = harness("detailed");
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

test("a sink with no status channel writes the message and nothing beside it", async () => {
  // The shape a medium with no second channel has, and the reason there is no
  // `detail` level meaning the same thing.
  const answer: string[] = [];
  const status: string[] = [];
  const sink: Sink = { write: (text) => answer.push(text) };
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

/**
 * A tool call is not exclusive, and the spinner used to assume it was.
 *
 * Each `tool.started` assigned a fresh interval over the last one without
 * clearing it, so four concurrent calls left three orphans drawing `\r` to the
 * same line for the life of the process — fighting each other, and cutting into
 * streamed text and committed status lines alike. One line, one ticker, and
 * every timer it starts is cleared.
 */
test("concurrent tool calls share one spinner, and every timer it starts is cleared", async () => {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let started = 0;
  let cleared = 0;
  globalThis.setInterval = ((...args: Parameters<typeof realSet>) => {
    started += 1;
    return realSet(...args);
  }) as typeof realSet;
  globalThis.clearInterval = ((timer: Parameters<typeof realClear>[0]) => {
    cleared += 1;
    return realClear(timer);
  }) as typeof realClear;

  try {
    const { sink } = harness();
    const calls = ["c1", "c2", "c3", "c4"];
    await renderRun(runOf([
      at({
        type: "assistant", runId: "r", content: "",
        calls: calls.map((callId) => ({ callId, name: "bash", arguments: "{}" })),
      }),
      ...calls.map((callId) => at({ type: "tool.started", runId: "r", callId })),
      ...calls.map((callId) => at({ type: "tool.finished", runId: "r", callId, result: { content: "ok" } })),
    ]), { ...sink, tty: true });

    // One line on the terminal, so one thing drawing it however many are running.
    expect(started).toBe(1);
    // And it is stopped, rather than left ticking over a finished run.
    expect(cleared).toBeGreaterThanOrEqual(1);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

/** Every committed line starts clean, whether or not a spinner was on the terminal. */
test("a committed line erases the spinner rather than landing on top of it", async () => {
  const { sink, status } = harness();
  await renderRun(runOf([
    at({
      type: "assistant", runId: "r", content: "",
      calls: [{ callId: "c1", name: "bash", arguments: "{}" }, { callId: "c2", name: "read", arguments: "{}" }],
    }),
    at({ type: "tool.started", runId: "r", callId: "c1" }),
    at({ type: "tool.started", runId: "r", callId: "c2" }),
    at({ type: "tool.finished", runId: "r", callId: "c1", result: { content: "ok" } }),
  ]), { ...sink, tty: true });

  // Nothing the reader keeps is glued to the end of a spinner frame: every
  // status line this run committed begins at the start of one.
  for (const written of status) {
    if (written.startsWith("\r")) continue;
    expect(written.endsWith("\n")).toBe(true);
  }
});

/**
 * A turn's own words are not a prefix of the next turn's.
 *
 * `streamed` records what a reader has already seen of the entry about to
 * arrive, so only a delta may add to it. Writing an entry through the same door
 * left that entry's text in there, and the next turn was then measured against
 * a prefix it does not begin with — so `startsWith` failed and the whole turn
 * printed again, under the half that had already streamed.
 */
test("a second turn prints what streamed and no more, whatever the first turn said", async () => {
  const { sink, answer } = harness();
  await renderRun(runOf([
    at({ type: "assistant", runId: "r", content: "Looking around." }, 1),
    { type: "text.delta", text: "The balance is " },
    at({ type: "assistant", runId: "r", content: "The balance is 1250." }, 2),
  ]), sink);

  expect(answer.join("")).toBe("Looking around.\nThe balance is 1250.\n");
});
