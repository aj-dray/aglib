import type { Delivery, Entry, Stored } from "../session/entry.js";
import type { Failure, Result } from "../result.js";
import type { JsonValue } from "../json.js";

export interface AgentRef { id: string; version: string }

export interface StoreError extends Failure {
  code: "unavailable" | "not-found" | "conflict" | "failed";
}

/** Someone else advanced this session first. Retry means re-read and re-decide, not re-send. */
export interface StoreConflict extends StoreError { code: "conflict"; actualSeq: number }

/**
 * A session id and a run id are UUIDs.
 *
 * `runAgent` mints both with `crypto.randomUUID()` and the library never
 * produces anything else, so the only place another shape could enter is a
 * caller-supplied `sessionId` — and stating it is what lets a store keep them
 * in a `uuid` column, which is not a detail: it is sixteen bytes and index
 * locality on the hottest table a deployment has. Left unstated, a store that
 * did so was narrowing a contract nobody had written down.
 *
 * An application's own naming goes in `key`, which exists for exactly that and
 * is opaque here.
 */
export interface SessionRead {
  sessionId: string;
  agent: AgentRef;
  seq: number;
  metadata: JsonValue;
  entries: readonly Stored[];
  /** Undelivered input. Visible to any process, which is how a delivery to a busy session is noticed. */
  pending: readonly Delivery[];
}

export interface SessionSummary {
  sessionId: string;
  agent: AgentRef;
  key: string | null;
  seq: number;
  metadata: JsonValue;
  updatedAt: string;
}

export interface Runnable {
  sessionId: string;
  seq: number;
  /**
   * What was waiting, with provenance and priority.
   *
   * Reading does not consume: the queue is cleared by the append that commits
   * these as entries, in the same compare-and-swap. A worker that loses that
   * race therefore leaves the messages where it found them, instead of having
   * already destroyed them.
   */
  pending: readonly Delivery[];
  metadata: JsonValue;
}

/**
 * Which session changed, and whether it now has work owed to it.
 *
 * Deliberately not the change itself. A watcher cannot read state from this and
 * must not try: it says a session moved, and the only correct response is to
 * ask the store what it says now. Carrying the entries here would make a second
 * path to the log — one with no cursor, no ordering and no durability — beside
 * the one that has all three.
 */
export interface StoreChange {
  sessionId: string;
  /** Whether that session now has undelivered input. Not whether `next` would return it. */
  runnable: boolean;
}

/**
 * Ordered, atomically-appended session logs. Seven methods, and one optional.
 *
 * Two mechanisms, and they do different jobs. `expectedSeq` is the correctness
 * one: a write from a stale position loses and is told the real one, so no two
 * writers can interleave at the same position. The claim taken by `next` is the
 * exclusion one: it stops a second worker from starting a *second activation*
 * of a session that is already running.
 *
 * Both are needed, and one does not imply the other. Compare-and-swap alone
 * permits two activations to run concurrently at different positions, each
 * committing happily until one of them loses a race mid-turn — which leaves a
 * tool call asked and never answered, and destroys the messages the loser took.
 * That is a real failure, observed, not a theoretical one.
 *
 * The claim is deliberately small: no renewal, no fencing token. It expires on
 * its own so a worker that dies does not strand a session, and if that worker
 * turns out to be alive its writes still fail the compare-and-swap. The claim
 * saves work; the compare-and-swap is what makes the work safe.
 */
export interface Store {
  create(input: {
    sessionId: string;
    agent: AgentRef;
    /** Opaque application index key — a user, tenant, channel or parent session. Never interpreted. */
    key?: string;
    metadata?: JsonValue;
  }): Promise<Result<void, StoreError>>;

  read(input: { sessionId: string; afterSeq?: number }): Promise<Result<SessionRead, StoreError>>;

  /**
   * The one operation that makes orchestration safe. Entries, deliveries to
   * other sessions, and a metadata merge commit together or not at all — so a
   * handoff between agents can never be lost or duplicated.
   */
  append(input: {
    sessionId: string;
    expectedSeq: number;
    entries: readonly Entry[];
    enqueue?: readonly Delivery[];
    metadata?: JsonValue;
    /**
     * Remove this many deliveries from the front of this session's own queue,
     * in the same transaction. This is how input taken from `next` is consumed:
     * the messages are gone only once the entries carrying them are committed.
     * Anything that arrived since is behind them and survives.
     *
     * More than the queue holds is refused, never clamped. It is only ever
     * `claim.pending.length`, so a larger number means the caller is working
     * from a queue that is not there — and clamping it would drop messages
     * nothing recorded, which is the one loss this design exists to prevent.
     */
    takePending?: number;
  }): Promise<Result<{ seq: number }, StoreConflict | StoreError>>;

  /**
   * Sessions by the application's opaque key, newest first.
   *
   * `before` is a page boundary, and its shape is part of the contract because
   * a caller has to be able to build one: `"<updatedAt>|<sessionId>"`, taken
   * from the last row of the previous page. The id is in it because sessions
   * written in the same instant have no order without it, and a plain `<` on
   * the timestamp then steps over every row that shares the boundary. Left
   * unsaid, two stores answered it two different ways and one of them ignored
   * it entirely.
   */
  list(input: { key?: string; limit?: number; before?: string }): Promise<Result<readonly SessionSummary[], StoreError>>;

  /**
   * Claim the next session that has input and is not already running.
   *
   * The queue is reported, not taken — see `takePending`. `undefined` means
   * nothing is owed, everything owed is already being worked on, or the caller
   * gave up: a `signal` that has already aborted answers `undefined`, because
   * nothing is owed to somebody who stopped asking.
   */
  next(input: { signal?: AbortSignal }): Promise<Result<Runnable | undefined, StoreError>>;


  /**
   * Claim a session whose activation was interrupted: an open run whose claim
   * has lapsed, with nothing waiting to make it runnable the ordinary way.
   *
   * `next` answers what has been asked for, which is the right question almost
   * always. This is the other one — what was being worked when a process
   * stopped existing — and without it that work is invisible. `next` skips a
   * session with an open activation, on purpose; the queue that made it
   * runnable was consumed by the commit that recorded it; so a session whose
   * worker was killed mid-run is owed to nobody and waits for a stranger to
   * speak to it. Every application built on this rediscovers that, and the
   * store is the only thing that can see it.
   *
   * Separate from `next` rather than folded into it because resuming is a
   * decision, not a default: an application may want interrupted work finished
   * at once, or left for whoever speaks to the session next. `pending` is empty
   * by construction — a session with input waiting is `next`'s.
   *
   * Claimed on the same terms and with the same window. A run that commits
   * nothing at all for longer than `claimMs` looks the same as one whose
   * process died, here as in `next`. Two more consequences of that window,
   * both accepted:
   *
   * An interrupted run is invisible until its claim lapses, so a killed
   * worker's session waits out `claimMs` before anyone can pick it up. That is
   * the price of having no heartbeat and no fencing token.
   *
   * A store keeps one mark for "claimed" and "an activation is open", on
   * purpose — two fields could disagree, and the log is the only thing that
   * knows. The cost is that a session claimed by `next` whose worker committed
   * something other than `run.started` is indistinguishable from an interrupted
   * run. `runAgent` always opens with one, so this is reachable only by a
   * caller writing entries itself.
   */
  interrupted(input: { signal?: AbortSignal }): Promise<Result<Runnable | undefined, StoreError>>;

  /**
   * Be told to look again, instead of asking on a timer.
   *
   * Optional, and honestly so: a store reached over a channel with no push —
   * a file, a plain HTTP API — cannot offer this, and pretending otherwise
   * would be a promise nothing keeps. A caller branches on its absence.
   *
   * **It is an interrupt line, not a feed of events.** A wake is a request to
   * look, never a description of what to do. That is what makes it safe to be
   * wrong about: a spurious wake costs one query, and a lost wake costs the
   * heartbeat rather than the work.
   *
   * What is promised:
   *
   * - A watcher is called only once the change is readable through this store,
   *   so looking after a wake always finds at least what woke it.
   * - A change committed through this store wakes this store's own watchers,
   *   including when the writer and the reader are the same process. That
   *   sounds obvious and is the defect an implementation actually shipped: it
   *   skipped its own notification to avoid an echo, and a delivery written by
   *   the surface woke the worker beside it not at all.
   * - Unsubscribing is idempotent, and `close()` ends every watch. A wake
   *   already on its way when either is called is not delivered.
   * - A watcher that throws is the caller's own bug. It does not fail the write
   *   that woke it and does not cost another watcher its wake; the error
   *   surfaces where an unhandled one does. That last part is deliberately not
   *   a conformance case, because a case that provokes it fails the run that
   *   asserts it.
   *
   * What is not:
   *
   * - **Delivery.** A connection that was down when a change landed loses that
   *   wake for good. A caller keeps a heartbeat; this removes latency, not the
   *   need to look.
   * - **Reach.** How far a store sees is the store's own, and it says so where
   *   it can be held to it: the conformance subject declares `process` or
   *   `deployment`, and a feed claiming the second must prove a write on one
   *   connection wakes a watcher on another. Nothing branches on it at runtime,
   *   which is why it is not a field here — the heartbeat is mandatory either
   *   way, so the difference is latency, not correctness.
   * - **One wake per change.** Several may arrive as one, and one may arrive
   *   twice.
   * - **Ordering** between sessions, or against any other wake.
   */
  watch?(watcher: (change: StoreChange) => void): () => void;

  close(): Promise<void>;
}

/** Re-exported for the same reason the model port re-exports its own. */
export type { Delivery };
