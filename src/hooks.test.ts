import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runAgent } from "./run.js";
import { createNativeHarness } from "./harness/adapters/native/loop.js";
import { createFakeModel } from "./model/adapters/fake/index.js";
import { createSqliteStore } from "./store/adapters/sqlite.js";
import { err } from "./result.js";
import type { Agent } from "./agent.js";
import type { Model } from "./model/model.js";

const agent = (model: Model, hooks: Agent["hooks"]): Agent => ({
  id: "hooks", version: "1", instructions: "Work", harness: createNativeHarness({ model }), hooks,
});

test("one durable reminder continues the same activation; observers see its terminal write", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  const events: string[] = [];
  const result = await runAgent({ store, sessionId: "s", input: "help", agent: agent(
    createFakeModel([{ text: "private" }, { text: "still private" }]), [{
      name: "reminder",
      beforeRun: () => { events.push("start"); },
      beforeModel: () => { events.push("model"); },
      afterModel: () => { events.push("response"); },
      beforeStop: () => ({ input: "Consider sending your answer." }),
      afterRun: context => { expect(context.entries().at(-1)?.type).toBe("run.finished"); events.push("end"); },
    }],
  ) }).result;
  expect(result.status).toBe("completed");
  const read = await store.read({ sessionId: "s" });
  if (!read.ok) throw Error("read");
  expect(read.value.entries.map(entry => entry.type)).toEqual(["run.started", "assistant", "hook.input", "assistant", "run.finished"]);
  expect(new Set(read.value.entries.map(entry => entry.runId)).size).toBe(1);
  expect(read.value.pending).toHaveLength(0);
  expect(events).toEqual(["start", "model", "response", "model", "response", "end"]);
});

test("resuming after the reminder committed does not grant another reminder", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({ sessionId: "s", agent: { id: "hooks", version: "1" } });
  await store.append({ sessionId: "s", expectedSeq: 0, entries: [
    { type: "run.started", runId: "r", input: "help" },
    { type: "assistant", runId: "r", content: "private" },
    { type: "hook.input", runId: "r", hook: "reminder", input: "Consider sending." },
  ] });
  const result = await runAgent({ store, claim: { sessionId: "s", seq: 3, pending: [], agent: { id: "hooks", version: "1" } }, agent: agent(
    createFakeModel([{ text: "done" }]), [{ name: "reminder", beforeStop: () => ({ input: "Again?" }) }],
  ) }).result;
  expect(result.status).toBe("completed");
  const read = await store.read({ sessionId: "s" });
  if (!read.ok) throw Error("read");
  expect(read.value.entries.filter(entry => entry.type === "hook.input")).toHaveLength(1);
});

test("hard failure and cancellation cannot be continued; cleanup runs despite a broken observer", async () => {
  for (const cancelled of [false, true]) {
    let calls = 0;
    let cleaned = false;
    const model: Model = { id: "credit", async *generate() { calls++; return err({ code: "failed", message: "402 insufficient credit", retryable: false }); } };
    const run = runAgent({ input: "help", ...(cancelled ? { signal: AbortSignal.abort() } : {}), agent: agent(model, [
      { name: "reminder", beforeStop: () => ({ input: "Try again" }) },
      { name: "broken", afterRun: () => { throw Error("observer broke"); } },
      { name: "cleanup", afterRun: () => { cleaned = true; } },
    ]) });
    const updates = [];
    for await (const update of run) updates.push(update);
    const result = await run.result;
    expect(result.status).toBe(cancelled ? "cancelled" : "failed");
    if (!cancelled && result.status === "failed") expect(result.error.message).toBe("402 insufficient credit");
    expect(calls).toBe(cancelled ? 0 : 1);
    expect(cleaned).toBe(true);
    expect(updates.some(update => update.type === "hook.error" && update.hook === "broken")).toBe(true);
  }
});

test("a throwing preparation hook closes the run and still releases resources", async () => {
  let cleaned = false;
  const run = runAgent({ input: "help", agent: agent(createFakeModel([]), [{
    name: "resources", beforeRun: () => { throw Error("setup failed"); }, afterRun: () => { cleaned = true; },
  }]) });
  const entries = [];
  for await (const update of run) if (update.type === "entry") entries.push(update.entry);
  expect((await run.result).status).toBe("failed");
  expect(entries.at(-1)?.type).toBe("run.finished");
  expect(cleaned).toBe(true);
});
