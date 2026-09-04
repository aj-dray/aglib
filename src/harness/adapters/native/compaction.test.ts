import { expect, test } from "bun:test";
import { compactionCut } from "./compaction.js";
import { toMessages } from "../../../session/messages.js";
import type { Entry, Stored } from "../../../session/entry.js";

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
  const cut = compactionCut(entries);
  expect(cut).toBeDefined();
  // Between two batches, so the tail the fold keeps verbatim is still there.
  expect(cut!).toBeGreaterThan(0);
  expect(cut!).toBeLessThan(entries.length);
  expect(entries[cut! - 1]?.type).toBe("tool.finished");
});

test("a call and its result never straddle the cut", () => {
  for (const batches of [1, 2, 3, 9, 40]) {
    const entries = activation(batches);
    const cut = compactionCut(entries);
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
      if (message.role === "tool") expect(asked.has(message.callId)).toBe(true);
    }
  }
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
  expect(compactionCut(entries)).toBe(5);
});
