/**
 * What any implementation of the store port must do.
 *
 * The port is seven methods and two mechanisms, and the mechanisms are the part
 * that goes wrong. `expectedSeq` is correctness and the claim is exclusion; one
 * does not imply the other; and the failure from confusing them is not a
 * rejected write but a log a provider will not accept, discovered in
 * production. Every store written from the interface alone re-derives those
 * rules, and a store that gets them subtly wrong looks exactly like one that
 * does not until two workers meet.
 *
 * So the contract is executable. These cases say what the interface means —
 * that a claim does not consume, that a queue survives a lost race, that an
 * open activation renews by writing rather than by having started, that a
 * delivery id outlives the queue — and an adapter runs them rather than reading
 * them.
 *
 * Inert on purpose. Each case is a name and a function that throws, so the
 * suite drags no test framework into the package and an adapter runs it under
 * whichever one it already has:
 *
 * ```ts
 * for (const item of defineStoreConformance({ open })) test(item.name, item.run);
 * ```
 */
import type { Runnable, Store, StoreChange } from "./store.js";
import type { Delivery, Entry, Stored } from "../session/entry.js";
import type { Failure, Result } from "../result.js";

/** One case: a name, and a function that throws when the contract is broken. */
export interface ConformanceCase {
  name: string;
  run(): Promise<void>;
}

export interface StoreUnderTest {
  /**
   * A store with no sessions in it, whose claim lapses after `claimMs`.
   *
   * Called once per case, so nothing leaks between them. The window is the
   * suite's because two cases turn on a claim expiring, and waiting out a
   * production default would take ten minutes.
   */
  open(input: { claimMs: number }): Promise<Store> | Store;
  /** Release whatever `open` provisioned. `Store.close` is called first. */
  release?(store: Store): Promise<void> | void;
  /**
   * How far this store's change feed reaches.
   *
   * Declared rather than inferred from the method being there, so a store that
   * has a push channel and never wired it up fails here instead of quietly
   * costing every worker built on it a poll — and so that "reach is the store's
   * own to state" has somewhere to be stated and held to.
   *
   * `"process"` wakes watchers on this instance: the HTTP surface writes and
   * the worker beside it hears, which is most deployments. `"deployment"` wakes
   * a watcher on another connection too, and owes a `peer` to prove it.
   */
  changes: "none" | "process" | "deployment";
  /**
   * A second store on the same data, for a feed claiming `"deployment"`. Not
   * `open`, which is entitled to start from nothing.
   */
  peer?(input: { claimMs: number }): Promise<Store> | Store;
}

/**
 * Short enough that a case can wait a claim out, long enough that two calls in
 * a row are inside one — a store reached over a socket takes real time, and a
 * window measured in tens of milliseconds tests the scheduler rather than the
 * contract.
 */
const CLAIM_MS = 500;
const LAPSE_MS = CLAIM_MS + 150;

/**
 * A readable name for a session or a run, and a real id for the store.
 *
 * The cases read better with `parent` and `child` than with two UUIDs, and a
 * store reads them as what the port says they are. Memoised for the whole run
 * rather than per case, which costs nothing: every case gets its own store.
 */
const named = new Map<string, string>();
const id = (name: string): string => {
  const known = named.get(name);
  if (known) return known;
  const minted = crypto.randomUUID();
  named.set(name, minted);
  return minted;
};

const agent = { id: "conformance", version: "1" };

const said = (input: string, runId = id("r")): Entry => ({ type: "run.started", runId, input });
const ended = (runId = id("r")): Entry => ({ type: "run.finished", runId, outcome: "completed" });
const wrote = (content: string, runId = id("r")): Entry => ({ type: "assistant", runId, content });

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function fail(what: string): never {
  throw new Error(`store conformance: ${what}`);
}

function holds(condition: boolean, what: string): asserts condition {
  if (!condition) fail(what);
}

function same(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, at) => same(item, expected[at]));
  }
  if (typeof actual !== "object" || typeof expected !== "object" || !actual || !expected) return false;
  const left = Object.keys(actual as object).sort();
  const right = Object.keys(expected as object).sort();
  return same(left, right)
    && left.every((key) => same((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]));
}

function equals(actual: unknown, expected: unknown, what: string): void {
  if (!same(actual, expected)) {
    fail(`${what} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Unwraps a `Result` the case expects to have succeeded. */
function got<T>(result: Result<T, Failure>, what: string): T {
  if (!result.ok) fail(`${what} — ${result.error.code}: ${result.error.message}`);
  return result.value;
}

export function defineStoreConformance(subject: StoreUnderTest): readonly ConformanceCase[] {
  const cases: ConformanceCase[] = [];

  const define = (name: string, body: (store: Store) => Promise<void>): void => {
    cases.push({
      name,
      async run() {
        const store = await subject.open({ claimMs: CLAIM_MS });
        try {
          await body(store);
        } finally {
          await store.close();
          await subject.release?.(store);
        }
      },
    });
  };

  /** An empty session — no entries, nothing owed — under an optional application key. */
  const created = async (store: Store, sessionId: string, key?: string): Promise<void> => {
    got(await store.create({ sessionId, agent, ...(key ? { key } : {}) }), `create ${sessionId}`);
  };

  const entriesOf = async (store: Store, sessionId: string): Promise<readonly Stored[]> =>
    got(await store.read({ sessionId }), `read ${sessionId}`).entries;

  const claim = async (store: Store): Promise<Runnable | undefined> =>
    got(await store.next({}), "next");

  const interrupted = async (store: Store): Promise<Runnable | undefined> =>
    got(await store.interrupted({}), "interrupted");

  // ---- The log ------------------------------------------------------------

  define("entries come back in order, and a cursor returns only what is new", async (store) => {
    await created(store, id("s"));
    const written = got(
      await store.append({ sessionId: id("s"), expectedSeq: 0, entries: [said("one"), said("two")] }), "append");
    equals(written.seq, 2, "the append reports the position it left the session at");

    const all = got(await store.read({ sessionId: id("s") }), "read");
    equals(all.entries.map((entry) => entry.seq), [1, 2], "positions are 1 and 2");
    equals(all.seq, 2, "the session is at 2");
    holds(all.entries.every((entry) => typeof entry.at === "string" && !Number.isNaN(Date.parse(entry.at))),
      "every stored entry carries an ISO 8601 commit time");

    const after = got(await store.read({ sessionId: id("s"), afterSeq: 1 }), "read after 1");
    equals(after.entries.map((entry) => entry.seq), [2], "a cursor returns only what is new");
    equals(after.seq, 2, "a cursor read still reports the session's real position");
  });

  define("a session that was never created is not-found rather than empty", async (store) => {
    const read = await store.read({ sessionId: id("nobody") });
    holds(!read.ok, "reading an unknown session fails");
    equals(read.error.code, "not-found", "the code says not-found");
  });

  define("entries survive the round trip whole", async (store) => {
    await created(store, id("s"));
    const rich: Entry = {
      type: "assistant", runId: id("r"),
      content: [{ type: "text", text: "here" }, { type: "opaque", provider: "acme", data: { keep: [1, null, "x"] } }],
      calls: [{ callId: "c1", name: "look", arguments: "{\"at\":1}" }],
      usage: { inputTokens: 10, outputTokens: 2 },
      providerState: { provider: "acme-wire", items: [{ signature: "sig-9" }, "opaque"] },
      generation: { id: "g", model: "m", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z" },
    };
    got(await store.append({ sessionId: id("s"), expectedSeq: 0, entries: [rich] }), "append");
    const [stored] = await entriesOf(store, id("s"));
    holds(stored !== undefined, "the entry was stored");
    const { seq, at, ...body } = stored;
    equals(body, rich, "the entry comes back exactly as it went in");
  });

  define("a session carries the agent and the metadata it was created with", async (store) => {
    got(await store.create({ sessionId: id("s"), agent, key: "tenant", metadata: { model: "one" } }), "create");
    got(await store.append({ sessionId: id("s"), expectedSeq: 0, entries: [said("go")] }), "append");

    const read = got(await store.read({ sessionId: id("s") }), "read");
    equals(read.agent, agent, "a read says whose session this is");
    equals(read.metadata, { model: "one" }, "and hands back what create was given, uninterpreted");

    // A summary carries the same facts because a listing is how an application
    // finds a session it has no id for — one that had to read each row to learn
    // its agent or position would be a listing in name only.
    const [summary] = got(await store.list({ key: "tenant" }), "list");
    holds(summary !== undefined, "the session is listed under its key");
    equals(summary.agent, agent, "a summary says whose session it is");
    equals(summary.seq, 1, "and where its log has got to");
    equals(summary.metadata, { model: "one" }, "and carries the metadata without a second read");
  });

  // ---- Compare-and-swap ---------------------------------------------------

  define("a write from a stale position is refused and told the real one", async (store) => {
    await created(store, id("s"));
    got(await store.append({ sessionId: id("s"), expectedSeq: 0, entries: [said("one")] }), "append");

    const stale = await store.append({ sessionId: id("s"), expectedSeq: 0, entries: [said("two")] });
    holds(!stale.ok, "a stale write is refused");
    equals(stale.error.code, "conflict", "the code says conflict");
    equals((stale.error as { actualSeq?: number }).actualSeq, 1, "the refusal carries the real position");
    equals((await entriesOf(store, id("s"))).length, 1, "nothing of the refused write survives");
  });

  define("an append to a session that is not there is not-found", async (store) => {
    const missing = await store.append({ sessionId: id("nobody"), expectedSeq: 0, entries: [said("one")] });
    holds(!missing.ok, "appending to an unknown session fails");
    equals(missing.error.code, "not-found", "the code says not-found");
  });

  define("metadata merges rather than replacing", async (store) => {
    await created(store, id("s"));
    got(await store.append({ sessionId: id("s"), expectedSeq: 0, entries: [], metadata: { model: "one", tenant: "acme" } }), "first merge");
    got(await store.append({ sessionId: id("s"), expectedSeq: 0, entries: [], metadata: { model: "two" } }), "second merge");
    equals(got(await store.read({ sessionId: id("s") }), "read").metadata, { model: "two", tenant: "acme" },
      "the key that was not written keeps its value");
  });

  // ---- Delivery, atomically ----------------------------------------------

  define("a delivery to another session commits with the sender's own entries", async (store) => {
    await created(store, id("parent"));
    await created(store, id("child"), "parent");
    got(await store.append({
      sessionId: id("parent"), expectedSeq: 0, entries: [said("spawn a child")],
      enqueue: [{ sessionId: id("child"), input: "do the thing", from: { kind: "session", id: id("parent") } }],
    }), "append with a delivery");

    const runnable = await claim(store);
    holds(runnable?.sessionId === id("child"), "the recipient is runnable");
    // The fields the port names, not the object. A store is entitled to hand
    // back a delivery with its default priority materialised — the caller sent
    // none and `next` is what none means — and comparing whole objects called
    // that a difference.
    equals(runnable.pending.length, 1, "one delivery is waiting");
    const [waiting] = runnable.pending;
    equals(waiting?.sessionId, id("child"), "addressed to the recipient");
    equals(waiting?.input, "do the thing", "carrying what was sent");
    equals(waiting?.from?.kind, "session", "sent by a session");
    equals(waiting?.from?.id, id("parent"), "and which one");
    equals(runnable.seq, 0, "the recipient's position is its own, not the sender's");
  });

  define("a rejected append delivers nothing", async (store) => {
    await created(store, id("sender"));
    await created(store, id("target"));
    got(await store.append({ sessionId: id("sender"), expectedSeq: 0, entries: [said("one")] }), "append");

    const stale = await store.append({
      sessionId: id("sender"), expectedSeq: 0, entries: [said("two")],
      enqueue: [{ sessionId: id("target"), input: "never sent" }],
    });
    holds(!stale.ok, "the stale write is refused");
    equals(got(await store.read({ sessionId: id("target") }), "read target").pending, [],
      "the recipient received nothing");
  });

  define("a delivery to a session that is not there fails and commits nothing", async (store) => {
    await created(store, id("sender"));
    const missing = await store.append({
      sessionId: id("sender"), expectedSeq: 0, entries: [said("one")],
      enqueue: [{ sessionId: id("nobody"), input: "into the void" }],
    });
    holds(!missing.ok, "a delivery to an unknown session fails");
    equals(missing.error.code, "not-found", "the code says not-found");
    equals((await entriesOf(store, id("sender"))).length, 0, "the sender's own entries went with it");
  });

  // ---- The queue and the claim -------------------------------------------

  define("a shared message is delivered once to each recipient, independently of consumption", async (store) => {
    for (const name of ["sender", "first", "second"]) await created(store, id(name));
    const enqueue: Delivery[] = ["first", "second"].map((name) => ({
      sessionId: id(name), input: "shared finding", id: "shared-message",
      from: { kind: "session", id: id("sender") }, priority: "turn",
    }));
    const written = got(await store.append({
      sessionId: id("sender"), expectedSeq: 0, entries: [said("send a finding")], enqueue,
    }), "send to both recipients");
    const first = got(await store.read({ sessionId: id("first") }), "first recipient");
    const second = got(await store.read({ sessionId: id("second") }), "second recipient");
    equals(first.pending.length, 1, "the first receives the message");
    equals(second.pending.length, 1, "the same delivery id also reaches the second");
    got(await store.append({
      sessionId: id("first"), expectedSeq: first.seq,
      entries: [said("shared finding", id("recipient-run")), ended(id("recipient-run"))], takePending: 1,
    }), "consume only the first recipient's input");
    got(await store.append({
      sessionId: id("sender"), expectedSeq: written.seq, entries: [], enqueue,
    }), "retry the shared message");
    equals(got(await store.read({ sessionId: id("first") }), "first after retry").pending.length, 0,
      "a consumed delivery is not recreated");
    equals(got(await store.read({ sessionId: id("second") }), "second after retry").pending.length, 1,
      "the other recipient still has precisely its original delivery");
  });

  define("one missing recipient rolls back every delivery and the sender's entries", async (store) => {
    await created(store, id("sender"));
    await created(store, id("recipient"));
    const written = await store.append({
      sessionId: id("sender"), expectedSeq: 0, entries: [said("share this")],
      enqueue: [
        { sessionId: id("recipient"), input: "must not arrive", id: "message" },
        { sessionId: id("missing"), input: "must not arrive", id: "message" },
      ],
    });
    holds(!written.ok, "a missing recipient refuses the append");
    equals(written.error.code, "not-found", "the missing recipient is named by the error code");
    equals((await entriesOf(store, id("sender"))).length, 0, "the sender's entries rolled back");
    equals(got(await store.read({ sessionId: id("recipient") }), "read recipient").pending.length, 0,
      "no partial delivery survives");
  });

  define("next claims without consuming: the queue survives until an append commits it", async (store) => {
    await created(store, id("s"));
    got(await store.append({
      sessionId: id("s"), expectedSeq: 0, entries: [], enqueue: [{ sessionId: id("s"), input: "read me" }],
    }), "enqueue");

    const claimed = await claim(store);
    holds(claimed?.sessionId === id("s"), "the session is claimed");
    equals(got(await store.read({ sessionId: id("s") }), "read").pending.length, 1,
      "reading the queue did not empty it");

    got(await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq, entries: [said("read me")], takePending: 1,
    }), "commit the delivery as an entry");
    equals(got(await store.read({ sessionId: id("s") }), "read").pending, [],
      "the write that recorded it is what removed it");
  });

  define("an append that loses its position destroys no messages", async (store) => {
    await created(store, id("s"));
    got(await store.append({
      sessionId: id("s"), expectedSeq: 0, entries: [], enqueue: [{ sessionId: id("s"), input: "read me" }],
    }), "enqueue");
    const claimed = await claim(store);
    holds(claimed !== undefined, "the session is claimed");

    // Somebody else advances the session while this worker holds the queue.
    got(await store.append({ sessionId: id("s"), expectedSeq: claimed.seq, entries: [wrote("elsewhere")] }), "other writer");

    const lost = await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq, entries: [said("read me")], takePending: 1,
    });
    holds(!lost.ok, "the loser is refused");
    equals(got(await store.read({ sessionId: id("s") }), "read").pending.length, 1,
      "the messages it was carrying are where it found them");
  });

  define("takePending removes what was committed and nothing that arrived since", async (store) => {
    await created(store, id("s"));
    got(await store.append({
      sessionId: id("s"), expectedSeq: 0, entries: [],
      enqueue: [{ sessionId: id("s"), input: "first" }, { sessionId: id("s"), input: "second" }],
    }), "enqueue two");
    const claimed = await claim(store);
    holds(claimed?.pending.length === 2, "both are reported");

    got(await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq, entries: [], enqueue: [{ sessionId: id("s"), input: "third" }],
    }), "a third arrives while the activation runs");
    got(await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq, entries: [said("first"), said("second")], takePending: 2,
    }), "commit the two that were taken");

    equals(got(await store.read({ sessionId: id("s") }), "read").pending.map((one: Delivery) => one.input), ["third"],
      "what arrived since is behind them and survives");
  });

  define("a session is claimed while it runs and released when the run finishes", async (store) => {
    await created(store, id("s"));
    got(await store.append({
      sessionId: id("s"), expectedSeq: 0, entries: [], enqueue: [{ sessionId: id("s"), input: "go" }],
    }), "enqueue");

    const claimed = await claim(store);
    holds(claimed !== undefined, "the session is claimed");
    got(await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq, entries: [said("go")], takePending: 1,
    }), "open the activation");
    got(await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq + 1, entries: [], enqueue: [{ sessionId: id("s"), input: "and again" }],
    }), "a message arrives mid-activation");

    equals(await claim(store), undefined, "a second activation of a running session is not offered");

    got(await store.append({ sessionId: id("s"), expectedSeq: claimed.seq + 1, entries: [ended()] }), "finish the run");
    const again = await claim(store);
    holds(again?.sessionId === id("s"), "the finished session is offered with what arrived while it ran");
  });

  define("an open activation holds its claim by writing, not by having started", async (store) => {
    await created(store, id("s"));
    got(await store.append({
      sessionId: id("s"), expectedSeq: 0, entries: [], enqueue: [{ sessionId: id("s"), input: "go" }],
    }), "enqueue");
    const claimed = await claim(store);
    holds(claimed !== undefined, "the session is claimed");
    got(await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq, entries: [said("go")], takePending: 1,
    }), "open the activation");
    got(await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq + 1, entries: [], enqueue: [{ sessionId: id("s"), input: "more" }],
    }), "a message arrives mid-activation");

    // A turn longer than the claim window. Every write the activation makes
    // renews it, or a second worker is handed a session that is still running —
    // and a compare-and-swap can refuse a write, not un-run a tool call.
    await wait(LAPSE_MS);
    got(await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq + 1, entries: [wrote("still working")],
    }), "the activation writes again");
    equals(await claim(store), undefined, "the running session is still not offered");
  });

  define("a claim lapses, so a worker that died does not strand its session", async (store) => {
    await created(store, id("s"));
    got(await store.append({
      sessionId: id("s"), expectedSeq: 0, entries: [], enqueue: [{ sessionId: id("s"), input: "go" }],
    }), "enqueue");
    holds((await claim(store)) !== undefined, "the session is claimed");
    equals(await claim(store), undefined, "and held");

    await wait(LAPSE_MS);
    const again = await claim(store);
    holds(again?.sessionId === id("s"), "the lapsed claim releases the session");
    equals(again.pending.length, 1, "with the messages still on it");
  });

  define("next takes the oldest waiting session, and does not read priority", async (store) => {
    await created(store, id("first"));
    await created(store, id("second"));
    got(await store.append({
      sessionId: id("first"), expectedSeq: 0, entries: [], enqueue: [{ sessionId: id("first"), input: "older" }],
    }), "enqueue to first");
    await wait(15);
    got(await store.append({
      sessionId: id("second"), expectedSeq: 0, entries: [],
      enqueue: [{ sessionId: id("second"), input: "urgent", priority: "interrupt" }],
    }), "enqueue to second");

    // Where a message lands in a running activation says nothing about which
    // session a worker picks up next. An application that needs urgent work
    // scheduled first orders its own workers.
    equals((await claim(store))?.sessionId, id("first"), "the oldest goes first");
    const urgent = await claim(store);
    equals(urgent?.sessionId, id("second"), "then the newer one");
    // Recorded and reported, though nothing here acted on it: the mode is the
    // harness's to honour, and it cannot honour what the store dropped.
    equals(urgent?.pending[0]?.priority, "interrupt", "the place the sender asked for reaches the reader");
  });

  // ---- Delivery identity --------------------------------------------------

  define("a delivery already waiting under the same id does not arrive twice", async (store) => {
    await created(store, id("s"));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      got(await store.append({
        sessionId: id("s"), expectedSeq: 0, entries: [],
        enqueue: [{ sessionId: id("s"), input: "once", id: "d1" }],
      }), `send ${attempt}`);
    }
    equals(got(await store.read({ sessionId: id("s") }), "read").pending.length, 1, "the retry collapsed into one");
  });

  define("a delivery id is remembered after its first copy has been read", async (store) => {
    await created(store, id("s"));
    got(await store.append({
      sessionId: id("s"), expectedSeq: 0, entries: [], enqueue: [{ sessionId: id("s"), input: "once", id: "d1" }],
    }), "first send");
    const claimed = await claim(store);
    holds(claimed !== undefined, "the session is claimed");
    got(await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq, entries: [said("once")], takePending: 1,
    }), "read it");

    got(await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq + 1, entries: [],
      enqueue: [{ sessionId: id("s"), input: "once", id: "d1" }],
    }), "the same delivery again");
    equals(got(await store.read({ sessionId: id("s") }), "read").pending, [],
      "an id is not forgotten the moment the queue drains");
  });

  define("two senders numbering their messages from one do not suppress each other", async (store) => {
    await created(store, id("one"));
    await created(store, id("two"));
    await created(store, id("target"));
    got(await store.append({
      sessionId: id("one"), expectedSeq: 0, entries: [],
      enqueue: [{ sessionId: id("target"), input: "from one", from: { kind: "session", id: id("one") }, id: "1" }],
    }), "sender one");
    got(await store.append({
      sessionId: id("two"), expectedSeq: 0, entries: [],
      enqueue: [{ sessionId: id("target"), input: "from two", from: { kind: "session", id: id("two") }, id: "1" }],
    }), "sender two");
    equals(got(await store.read({ sessionId: id("target") }), "read").pending.length, 2,
      "an id is the sender's own, so two of them are two deliveries");
  });

  // ---- Listing ------------------------------------------------------------

  define("listing is by the application's opaque key, newest first", async (store) => {
    await created(store, id("a"), "tenant-1");
    await wait(15);
    await created(store, id("b"), "tenant-1");
    await created(store, id("c"), "tenant-2");

    const mine = got(await store.list({ key: "tenant-1" }), "list");
    equals(mine.map((row) => row.sessionId), [id("b"), id("a")], "only that key, newest first");
    equals(mine[0]?.key, "tenant-1", "the key comes back as it was given");
    equals(got(await store.list({}), "list all").length, 3, "listing without a key sees every session");
  });

  define("a listing page does not step over the sessions sharing its boundary", async (store) => {
    // Written in one tick on purpose: without the id in the cursor, a page
    // boundary is an instant and every row sharing it is skipped.
    // `id(...)` shadowed by a loop variable is how a raw label reached a store
    // that keeps session ids as UUIDs, so these are named rather than reused.
    for (const label of ["a", "b", "c"]) await created(store, id(label), "tenant");
    const first = got(await store.list({ key: "tenant", limit: 1 }), "first page");
    holds(first.length === 1, "one row");
    const cursor = `${first[0]!.updatedAt}|${first[0]!.sessionId}`;
    const rest = got(await store.list({ key: "tenant", before: cursor }), "second page");
    equals(rest.length, 2, "the remaining two are on the next page");
    holds(!rest.some((row) => row.sessionId === first[0]!.sessionId), "and the first is not repeated");
  });

  // ---- Resumption ---------------------------------------------------------

  define("an interrupted activation is found once its claim lapses, and next cannot see it", async (store) => {
    await created(store, id("s"));
    got(await store.append({
      sessionId: id("s"), expectedSeq: 0, entries: [], enqueue: [{ sessionId: id("s"), input: "go" }],
    }), "enqueue");
    const claimed = await claim(store);
    holds(claimed !== undefined, "the session is claimed");
    // The commit that opened the run took the queue with it. This is the state
    // a killed worker leaves: an open activation and nothing owed.
    got(await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq, entries: [said("go")], takePending: 1,
    }), "open the activation");

    equals(await claim(store), undefined, "next has nothing: the session is running and nothing waits");
    equals(await interrupted(store), undefined, "and while the claim holds, nothing is handed back either");

    await wait(LAPSE_MS);
    equals(await claim(store), undefined, "still nothing has been asked for");
    const found = await interrupted(store);
    holds(found?.sessionId === id("s"), "the interrupted activation is found");
    equals(found.seq, claimed.seq + 1, "at the position its last commit left it");
    equals(found.pending, [], "with nothing waiting, by construction");
  });

  define("interrupted claims what it hands out", async (store) => {
    await created(store, id("s"));
    got(await store.append({ sessionId: id("s"), expectedSeq: 0, entries: [said("go")] }), "open the activation");
    await wait(LAPSE_MS);
    holds((await interrupted(store))?.sessionId === id("s"), "the first caller takes it");
    equals(await interrupted(store), undefined, "a second is not handed the same work");
  });

  define("a session that finished is neither runnable nor interrupted", async (store) => {
    await created(store, id("s"));
    got(await store.append({ sessionId: id("s"), expectedSeq: 0, entries: [said("go"), ended()] }), "a whole run");
    await wait(LAPSE_MS);
    equals(await claim(store), undefined, "nothing is owed");
    equals(await interrupted(store), undefined, "and nothing was left half-done");
  });

  define("a session with input waiting belongs to next, not to interrupted", async (store) => {
    await created(store, id("s"));
    got(await store.append({
      sessionId: id("s"), expectedSeq: 0, entries: [said("go")],
      enqueue: [{ sessionId: id("s"), input: "and this too" }],
    }), "an open activation with a message waiting");
    await wait(LAPSE_MS);
    equals(await interrupted(store), undefined, "interrupted leaves it alone");
    equals((await claim(store))?.sessionId, id("s"), "next takes it, with what it is owed");
  });

  define("a claim carries the session's metadata, from either question", async (store) => {
    // The claim is passed whole to the activation that follows, and metadata is
    // how an application configured this session — which model, whose tenant,
    // which sandbox. A claim without it is a claim the worker has to re-read.
    got(await store.create({ sessionId: id("owed"), agent, metadata: { model: "one" } }), "create owed");
    got(await store.create({ sessionId: id("open"), agent, metadata: { model: "two" } }), "create open");
    got(await store.append({
      sessionId: id("owed"), expectedSeq: 0, entries: [], enqueue: [{ sessionId: id("owed"), input: "go" }],
    }), "enqueue to the one that is owed input");
    got(await store.append({ sessionId: id("open"), expectedSeq: 0, entries: [said("go")] }), "open the other");

    const claimed = await claim(store);
    holds(claimed?.sessionId === id("owed"), "next takes the session with input");
    equals(claimed.metadata, { model: "one" }, "and hands back that session's metadata");

    await wait(LAPSE_MS);
    const found = await interrupted(store);
    holds(found?.sessionId === id("open"), "interrupted takes the open one");
    equals(found.metadata, { model: "two" }, "and hands back the same thing");
  });

  define("a claim lapses while a session is only spoken to, never worked", async (store) => {
    // The trap: a store that renewed on any append at all let a message *to* a
    // session renew the claim of the worker that was meant to read it. A dead
    // worker's session then stayed invisible to `next` — the claim never
    // lapsed — and to `interrupted`, whose queue was not empty. The messages
    // stayed there for ever.
    await created(store, id("s"));
    got(await store.append({
      sessionId: id("s"), expectedSeq: 0, entries: [], enqueue: [{ sessionId: id("s"), input: "go" }],
    }), "enqueue");
    const claimed = await claim(store);
    holds(claimed !== undefined, "the session is claimed");
    got(await store.append({
      sessionId: id("s"), expectedSeq: claimed.seq, entries: [said("go")], takePending: 1,
    }), "open the activation");

    // The worker dies here. Somebody keeps talking to the session, right up to
    // the moment of asking — so a store that renews on any write at all still
    // holds a fresh claim, and one that renews only on work does not.
    for (let sent = 0; sent < 4; sent += 1) {
      await wait(CLAIM_MS / 2);
      got(await store.append({
        sessionId: id("s"), expectedSeq: claimed.seq + 1, entries: [],
        enqueue: [{ sessionId: id("s"), input: `and ${sent}` }],
      }), `a later message ${sent}`);
    }

    const again = await claim(store);
    holds(again?.sessionId === id("s"), "the session is offered again once its own writes stop");
    equals(again.pending.length, 4, "with everything that arrived while nobody was reading");
  });

  define("taking more deliveries than are queued is refused, not clamped", async (store) => {
    // Silently dropping messages nothing recorded is the one loss this design
    // exists to prevent, and a caller's off-by-one reaches it.
    await created(store, id("s"));
    got(await store.append({
      sessionId: id("s"), expectedSeq: 0, entries: [],
      enqueue: [{ sessionId: id("s"), input: "one" }, { sessionId: id("s"), input: "two" }],
    }), "enqueue two");
    const over = await store.append({
      sessionId: id("s"), expectedSeq: 0, entries: [said("one")], takePending: 9,
    });
    holds(!over.ok, "a count larger than the queue is refused");
    equals(got(await store.read({ sessionId: id("s") }), "read").pending.length, 2,
      "and the messages are still there");
  });

  // ---- Being told to look again -------------------------------------------

  if (subject.changes === "none") {
    define("a store with no push channel says so by not offering one", async (store) => {
      holds(store.watch === undefined, "a store declaring no feed must not carry a `watch` that never fires");
    });
    return cases;
  }

  /** The next wake matching `want`, or a failure naming what never arrived. */
  const woken = (store: Store, want: (change: StoreChange) => boolean, what: string): Promise<StoreChange> => {
    holds(store.watch !== undefined, "a store declaring a feed must offer `watch`");
    return new Promise<StoreChange>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`store conformance: no wake for ${what}`)); }, 4_000);
      const off = store.watch!((change) => {
        if (!want(change)) return;
        clearTimeout(timer);
        off();
        resolve(change);
      });
    });
  };

  define("a change committed through this store wakes a watcher on this store", async (store) => {
    await created(store, id("s"));
    // Not a hypothetical: an implementation skipped its own notification to
    // avoid an echo, and since the surface that writes and the worker that
    // reads were one process, a delivery woke nobody at all.
    const wake = woken(store, (change) => change.sessionId === id("s"), "an append on the same store");
    got(await store.append({ sessionId: id("s"), expectedSeq: 0, entries: [said("one")] }), "append");
    await wake;
  });

  define("a wake means the change is already readable", async (store) => {
    await created(store, id("s"));
    const wake = woken(store, (change) => change.sessionId === id("s"), "an append");
    got(await store.append({ sessionId: id("s"), expectedSeq: 0, entries: [said("one")] }), "append");
    await wake;
    // Looking after a wake finds at least what woke it. A notification sent
    // before the commit is worse than none: the look finds nothing, and nothing
    // ever tells it again.
    equals((await entriesOf(store, id("s"))).length, 1, "the entry that caused the wake is there");
  });

  define("a delivery says the session it landed on is runnable", async (store) => {
    await created(store, id("sender"));
    await created(store, id("target"));
    const wake = woken(store, (change) => change.sessionId === id("target"), "a delivery to another session");
    got(await store.append({
      sessionId: id("sender"), expectedSeq: 0, entries: [said("go")],
      enqueue: [{ sessionId: id("target"), input: "do the thing" }],
    }), "append with a delivery");
    equals((await wake).runnable, true, "the recipient now has work owed to it");
  });

  if (subject.changes === "deployment") {
    cases.push({
      name: "a change on one connection wakes a watcher on another",
      async run() {
        // The reach a database store exists for. One that only hears itself is
        // a real feed and a useful one, but a worker in another process is then
        // carried entirely by its heartbeat — which is the difference between a
        // message arriving in milliseconds and in half a minute.
        holds(subject.peer !== undefined, "a feed claiming deployment reach owes a peer to prove it");
        const store = await subject.open({ claimMs: CLAIM_MS });
        const other = await subject.peer!({ claimMs: CLAIM_MS });
        try {
          await created(store, id("s"));
          const wake = woken(other, (change) => change.sessionId === id("s"), "a write on another connection");
          // Registering `LISTEN` is itself a round trip; the heartbeat is what
          // covers a change that lands before it completes.
          await wait(400);
          got(await store.append({
            sessionId: id("s"), expectedSeq: 0, entries: [], enqueue: [{ sessionId: id("s"), input: "wake up" }],
          }), "a delivery from the other connection");
          equals((await wake).runnable, true, "the far watcher hears that work is owed");
        } finally {
          await other.close();
          await store.close();
          await subject.release?.(store);
        }
      },
    });
  }

  define("unsubscribing stops the wakes", async (store) => {
    await created(store, id("s"));
    let seen = 0;
    const off = store.watch!(() => { seen += 1; });
    off();
    off(); // idempotent: releasing twice is what releasing asked for
    got(await store.append({ sessionId: id("s"), expectedSeq: 0, entries: [said("one")] }), "append");
    await wait(200);
    equals(seen, 0, "a watcher that let go is not called again");
  });

  return cases;
}
