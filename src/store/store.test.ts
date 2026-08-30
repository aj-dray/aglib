import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSqliteStore } from "./adapters/sqlite.js";
import { defineStoreConformance } from "./conformance.js";
import type { Entry } from "../session/entry.js";

// The contract itself lives in the conformance suite, so it is stated once and
// every store answers to the same words — this adapter here, a Postgres one in
// `recipes/agent-service`, and whatever an application writes next.
for (const item of defineStoreConformance({
  open: ({ claimMs }) => createSqliteStore({ database: new Database(":memory:"), claimMs }),
  // The feed is this store's own writes. That is the whole of its reach, and it
  // covers the case the port cares about: one process, one store, the surface
  // that writes a delivery beside the worker that reads it.
  // This instance's own writes. Another process on the same file, or a second
  // store on the same handle, is invisible to it — and the port asks a store to
  // say how far it reaches rather than imply one it does not have.
  changes: "process",
})) {
  test(`sqlite: ${item.name}`, item.run);
}

// What is left is this adapter's own, and belongs nowhere else.

const agent = { id: "a", version: "1" };
const said = (input: string): Entry => ({ type: "run.started", runId: "r", input });

test("a delivery id is forgotten once its window has passed", async () => {
  // How long an id is remembered is this adapter's configuration, not the
  // port's: the contract says a retry does not arrive twice, and says nothing
  // about how long a store must hold that against an id nobody sent again.
  const subject = createSqliteStore({ database: new Database(":memory:"), deliveryMemoryMs: 1 });
  await subject.create({ sessionId: "s", agent });
  await subject.append({
    sessionId: "s", expectedSeq: 0, entries: [],
    enqueue: [{ sessionId: "s", input: "once", from: { kind: "session", id: "p" }, id: "alert-1" }],
  });
  await subject.append({ sessionId: "s", expectedSeq: 0, entries: [said("once")], takePending: 1 });

  await new Promise((resolve) => setTimeout(resolve, 5));
  await subject.append({
    sessionId: "s", expectedSeq: 1, entries: [],
    enqueue: [{ sessionId: "s", input: "once", from: { kind: "session", id: "p" }, id: "alert-1" }],
  });

  const after = await subject.read({ sessionId: "s" });
  expect(after.ok && after.value.pending).toHaveLength(1);
});

test("the log lives beside the application's own tables in one handle", async () => {
  // The adapter takes a database rather than binding a driver, which is what
  // lets an application join its own rows against the log.
  const database = new Database(":memory:");
  database.exec("CREATE TABLE tickets (session_id TEXT PRIMARY KEY, subject TEXT)");
  const subject = createSqliteStore({ database });
  await subject.create({ sessionId: "s", agent, key: "acme" });
  database.query("INSERT INTO tickets (session_id, subject) VALUES (?, ?)").run("s", "billing");

  const joined = database.query(
    "SELECT t.subject FROM sessions s JOIN tickets t ON t.session_id = s.id WHERE s.key = ?",
  ).all("acme") as { subject: string }[];
  expect(joined).toEqual([{ subject: "billing" }]);
});
