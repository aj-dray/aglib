import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSqliteStore } from "aglib/store/adapters/sqlite";
import { work } from "./worker.ts";
import type { Running } from "./tools.ts";

/**
 * A session that can never run must fail once and stop being runnable.
 *
 * This is the regression for the worst bug in the recipe so far. `next` was
 * made non-destructive so a worker losing a race would not destroy the
 * messages it was carrying — correct, and it left `recordFailure` consuming
 * nothing. A session missing a credential therefore stayed runnable forever
 * and was retried at full speed, writing 1.39 million entries overnight and
 * provisioning a sandbox on every pass.
 *
 * The store's own tests could not have caught it: the contract was right and
 * the caller was wrong.
 */
test("a session that cannot be configured fails once and stops", async () => {
  const store = createSqliteStore({ database: new Database(":memory:") });
  await store.create({
    sessionId: "s",
    agent: { id: "agent-nowhere", version: "1" },
    // A harness this service does not have. It used to name `claude-code` and
    // rely on no credential being connected, which made the test a question
    // about the machine it ran on: with one in the environment the harness
    // configured, the run started, and the assertion below waited out a real
    // attempt. What is being tested is what happens when a session cannot be
    // configured, so the reason it cannot should not be ambient.
    metadata: { harness: "nowhere", title: "cannot run" },
  });
  await store.append({
    sessionId: "s", expectedSeq: 0, entries: [],
    enqueue: [{ sessionId: "s", input: "do something" }],
  });

  const stop = new AbortController();
  const running: Running = new Map();
  const worker = work({ store, running, serviceUrl: "http://127.0.0.1:0", signal: stop.signal });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  stop.abort();
  await worker;

  const read = await store.read({ sessionId: "s" });
  if (!read.ok) throw new Error("read failed");

  // The input was consumed by the attempt, so nothing is owed any more.
  expect(read.value.pending).toHaveLength(0);
  const owed = await store.next({});
  expect(owed.ok && owed.value).toBeUndefined();

  // And it was attempted once, not thousands of times.
  const failures = read.value.entries.filter((entry) => entry.type === "run.finished");
  expect(failures).toHaveLength(1);
  expect(read.value.entries.length).toBeLessThan(5);
});
