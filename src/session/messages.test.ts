import { expect, test } from "bun:test";
import { toMessages } from "./messages.js";
import type { Entry, Stored } from "./entry.js";

const log = (...entries: Entry[]): Stored[] =>
  entries.map((entry, index) => ({ ...entry, seq: index + 1, at: "2026-01-01T00:00:00.000Z" }));

test("projects a conversation, and places context by lifetime around the cache boundary", () => {
  const messages = toMessages({
    instructions: "Be brief.",
    context: { run: "<facts>metric</facts>", turn: "<now>2026</now>" },
    entries: log(
      { type: "run.started", runId: "r", input: "hello" },
      { type: "assistant", runId: "r", content: "hi", calls: [{ callId: "c1", name: "t", arguments: "{}" }] },
      { type: "tool.started", runId: "r", callId: "c1" },
      { type: "tool.finished", runId: "r", callId: "c1", result: { content: "42" } },
    ),
  });
  // Run-scoped context sits inside the cacheable system prefix; turn-scoped
  // context sits last, after it, so it is never written into the cache.
  expect(messages.map((message) => message.role)).toEqual(["system", "system", "user", "assistant", "tool", "system"]);
  expect(messages[1]?.content).toBe("<facts>metric</facts>");
  expect(messages.at(-1)?.content).toBe("<now>2026</now>");
  // tool.started is bookkeeping and is never shown to the model.
  expect(JSON.stringify(messages)).not.toContain("tool.started");
});

test("a summary folds what it replaces without deleting it", () => {
  const entries = log(
    { type: "run.started", runId: "r", input: "first" },
    { type: "assistant", runId: "r", content: "old answer" },
    { type: "summary", runId: "r", content: "we discussed pricing", replaces: 2 },
    { type: "run.started", runId: "r", input: "second" },
  );
  const messages = toMessages({ instructions: "i", entries });
  const text = messages.map((message) => String(message.content));
  expect(text).not.toContain("old answer");
  expect(text.some((content) => content.includes("<summary>"))).toBe(true);
  expect(text).toContain("second");
  // The source entries are still in the log — compaction changes the view only.
  expect(entries).toHaveLength(4);
});

test("a summary becomes user context, never an assistant turn", () => {
  const messages = toMessages({
    instructions: "i",
    entries: log({ type: "summary", runId: "r", content: "earlier", replaces: 0 }),
  });
  // Attributing a summary to the assistant would put words in the model's mouth.
  expect(messages.at(-1)?.role).toBe("user");
});

test("a call whose result never committed is closed, not left dangling", () => {
  // A provider rejects an assistant turn holding a call with no result, so a
  // session interrupted between asking and answering would otherwise be stuck
  // forever. The projection states what is known and invents no outcome.
  const messages = toMessages({
    instructions: "be useful",
    entries: [
      { type: "run.started", runId: "r", input: "go", seq: 1, at: "" },
      {
        type: "assistant", runId: "r", content: "", seq: 2, at: "",
        calls: [{ callId: "c1", name: "bash", arguments: "{}" }],
      },
    ],
  });
  const last = messages.at(-1);
  expect(last?.role).toBe("tool");
  expect(last).toMatchObject({ callId: "c1", isError: true });
  expect(String((last as { content: string }).content)).toContain("did not report back");
});

const arrivals = log(
  { type: "run.started", runId: "r", input: "did you see this?", from: { kind: "session", id: "scout" } },
  { type: "run.started", runId: "r", input: "and this?", from: { kind: "human", id: "adam" } },
  { type: "run.started", runId: "r", input: "unattributed" },
);

test("names the sender on an arrival, in the application's own words", () => {
  const text = toMessages({ instructions: "i", entries: arrivals, attribution: true })
    .map((message) => String(message.content));
  // Both halves reach the model. An agent that can see something arrived but not
  // whether a person or a peer sent it is the defect the pair exists to fix, and
  // the kind is the application's word, not one this package knows.
  expect(text[1]).toContain("[from session scout]");
  expect(text[2]).toContain("[from human adam]");
  // Absent means the application did not say. Nothing is invented for it.
  expect(text[3]).toBe("unattributed");
});

test("unasked, an arrival is the input and nothing else", () => {
  const text = toMessages({ instructions: "i", entries: arrivals })
    .map((message) => String(message.content));
  // The default, because an application that renders its own attribution would
  // otherwise hand the model two names for one sender.
  expect(text[1]).toBe("did you see this?");
  expect(text.join("")).not.toContain("[from");
  // The provenance is still on the log. This decides what the model reads, not
  // what was recorded.
  const first = arrivals[0];
  expect(first?.type === "run.started" && first.from).toEqual({ kind: "session", id: "scout" });
});
