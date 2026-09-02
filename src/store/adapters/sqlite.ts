import type {
  Store, StoreChange, StoreError, StoreConflict, SessionRead, SessionSummary, Runnable,
} from "../store.js";
import type { Delivery, Entry, Stored } from "../../session/entry.js";
import type { JsonValue } from "../../json.js";
import { err, ok } from "../../result.js";

/**
 * The minimum a driver must provide. Declared here rather than importing one so
 * the same file serves `node:sqlite` and `bun:sqlite`, and so an application can
 * hand in a database it already opened — which is what lets its own tables live
 * beside the log and join against it.
 */
export interface SqliteDatabase {
  exec(sql: string): void;
  query(sql: string): { all(...parameters: unknown[]): unknown[]; run(...parameters: unknown[]): unknown };
}

const tables = `
  CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    agent_id      TEXT NOT NULL,
    agent_ver     TEXT NOT NULL,
    key           TEXT,
    metadata      TEXT NOT NULL DEFAULT '{}',
    pending       TEXT NOT NULL DEFAULT '[]',
    last_seq      INTEGER NOT NULL DEFAULT 0,
    running_since TEXT,
    updated_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    session_id TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    at         TEXT NOT NULL,
    body       TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    session_id  TEXT NOT NULL,
    sender      TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    at          TEXT NOT NULL,
    PRIMARY KEY (session_id, sender, delivery_id)
  );
`;

/**
 * Columns added after a table had already shipped.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that exists, so a
 * column added later never appears in a database made by an older build — and
 * the first index over it fails with a raw `SQLiteError` from inside `bun:sqlite`,
 * which is no way to meet a store whose whole promise is that the log survives.
 * Additive only: a column is added, nothing is dropped, rewritten or lost.
 */
const added: readonly { table: string; column: string; type: string }[] = [
  { table: "sessions", column: "running_since", type: "TEXT" },
];

const indexes = `
  CREATE INDEX IF NOT EXISTS sessions_by_key ON sessions (key, updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS sessions_runnable ON sessions (updated_at) WHERE pending <> '[]';
  DROP INDEX IF EXISTS sessions_stranded; -- sessions_interrupted under its former name
  CREATE INDEX IF NOT EXISTS sessions_interrupted ON sessions (updated_at) WHERE running_since IS NOT NULL;
  CREATE INDEX IF NOT EXISTS deliveries_by_age ON deliveries (at);
`;

interface SessionRow {
  id: string; agent_id: string; agent_ver: string; key: string | null;
  metadata: string; pending: string; last_seq: number; running_since: string | null; updated_at: string;
}

/** `updatedAt` and the session id, so a page boundary is a point and not an instant. */
const splitCursor = (cursor: string): [string, string] => {
  const cut = cursor.lastIndexOf("|");
  return cut < 0 ? [cursor, ""] : [cursor.slice(0, cut), cursor.slice(cut + 1)];
};

/**
 * How long a claim holds before another worker may take the session.
 *
 * Long enough that an ordinary turn finishes inside it, short enough that a
 * worker killed mid-turn does not strand its session for an afternoon. If the
 * original worker is somehow still alive when it expires, its writes fail the
 * compare-and-swap, so the window governs wasted work and never correctness.
 */
const DEFAULT_CLAIM_MS = 10 * 60 * 1000;

/**
 * How long a delivery id is remembered.
 *
 * `id` means "this delivery, once" — a webhook redelivered ten seconds later,
 * a retried send, a cron that fired twice all collapse to one. That has to
 * outlive the queue, because the common case is a duplicate arriving after the
 * first copy was already read. It cannot be remembered forever, so it is
 * remembered for a window an application can set and reason about.
 */
const DEFAULT_DELIVERY_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

export function createSqliteStore(input: {
  database: SqliteDatabase;
  claimMs?: number;
  /** How long a delivery id is remembered. Defaults to seven days. */
  deliveryMemoryMs?: number;
}): Store {
  const database = input.database;
  const claimMs = input.claimMs ?? DEFAULT_CLAIM_MS;
  const deliveryMemoryMs = input.deliveryMemoryMs ?? DEFAULT_DELIVERY_MEMORY_MS;

  // Tables, then the columns an older build's tables lack, then the indexes —
  // which is the only order that works, because an index may be over a column
  // the migration is about to add.
  database.exec(tables);
  for (const { table, column, type } of added) {
    const present = database.query(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).all(table, column);
    if (!present.length) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  database.exec(indexes);

  const one = <T>(sql: string, parameters: readonly unknown[]): T | undefined =>
    database.query(sql).all(...parameters)[0] as T | undefined;
  const run = (sql: string, parameters: readonly unknown[]) => { database.query(sql).run(...parameters); };
  const notFound = (sessionId: string): StoreError =>
    ({ code: "not-found", message: `No session ${sessionId}`, retryable: false });
  const failed = (error: unknown): StoreError =>
    ({ code: "failed", message: error instanceof Error ? error.message : String(error), retryable: false });
  const queueOf = (row: { pending: string }): Delivery[] => JSON.parse(row.pending) as Delivery[];

  /**
   * Watchers, woken after a write is committed.
   *
   * Every call site is already past its `COMMIT`, which is what makes the change
   * readable. The microtask is for the other half: a watcher that throws must
   * not fail the write that woke it — it surfaces as the caller's own unhandled
   * error rather than as a refused append — and one that writes back through
   * this store must not do so from inside the stack of the write it is
   * answering.
   */
  const watchers = new Set<(change: StoreChange) => void>();
  const woke = (changes: readonly StoreChange[]): void => {
    if (!watchers.size || !changes.length) return;
    for (const watcher of [...watchers]) {
      // One microtask each. A watcher that throws must not fail the write that
      // woke it, and must not suppress the watchers after it in the loop — in
      // its own task the throw surfaces as the caller's unhandled error and
      // costs nobody else their wake. Membership is re-checked at delivery, so
      // a watcher that let go between the write and this task is not called:
      // `off()` says stop, and a queued wake is still a wake.
      queueMicrotask(() => {
        if (!watchers.has(watcher)) return;
        for (const change of changes) watcher(change);
      });
    }
  };

  return {
    /** Idempotent: a session that is already here keeps what it was created with. */
    async create({ sessionId, agent, key, metadata }) {
      try {
        const existing = one<{ id: string }>(`SELECT id FROM sessions WHERE id = ?`, [sessionId]);
        if (existing) return ok(undefined);
        run(
          `INSERT OR IGNORE INTO sessions (id, agent_id, agent_ver, key, metadata, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [sessionId, agent.id, agent.version, key ?? null, JSON.stringify(metadata ?? {}), new Date().toISOString()],
        );
        // Only a session that really appeared is a change, and a new one has
        // nothing waiting on it — announcing `runnable: false` for a session
        // that already had input would have been wrong rather than spurious.
        woke([{ sessionId, runnable: false }]);
        return ok(undefined);
      } catch (error) { return err(failed(error)); }
    },

    async read({ sessionId, afterSeq = 0 }) {
      try {
      const session = one<SessionRow>(`SELECT * FROM sessions WHERE id = ?`, [sessionId]);
      if (!session) return err(notFound(sessionId));
      const rows = database.query(
        `SELECT seq, at, body FROM entries WHERE session_id = ? AND seq > ? ORDER BY seq`,
      ).all(sessionId, afterSeq) as { seq: number; at: string; body: string }[];
      return ok<SessionRead>({
        sessionId,
        agent: { id: session.agent_id, version: session.agent_ver },
        seq: session.last_seq,
        metadata: JSON.parse(session.metadata) as JsonValue,
        entries: rows.map((row): Stored => ({ ...(JSON.parse(row.body) as Entry), seq: row.seq, at: row.at })),
        pending: queueOf(session),
      });
      } catch (error) { return err(failed(error)); }
    },

    /**
     * Entries, deliveries, metadata and the queue in one transaction.
     *
     * The compare-and-swap on `last_seq` decides everything else: a caller
     * working from a stale position loses and is told the real one, and because
     * the queue is consumed here rather than in `next`, a loser leaves the
     * messages it was carrying untouched.
     */
    async append({ sessionId, expectedSeq, entries, enqueue, metadata, takePending }) {
      const at = new Date().toISOString();
      try {
        // Inside the try: on a busy database this is where the failure lands,
        // and a throw here escaped the `Result` the port promises.
        database.exec("BEGIN IMMEDIATE");
        const session = one<SessionRow>(`SELECT * FROM sessions WHERE id = ?`, [sessionId]);
        if (!session) { database.exec("ROLLBACK"); return err(notFound(sessionId)); }
        if (session.last_seq !== expectedSeq) {
          database.exec("ROLLBACK");
          return err<StoreConflict>({
            code: "conflict", message: `Session moved to ${session.last_seq}`,
            retryable: true, actualSeq: session.last_seq,
          });
        }
        entries.forEach((entry, offset) => {
          run(`INSERT INTO entries (session_id, seq, at, body) VALUES (?, ?, ?, ?)`,
            [sessionId, expectedSeq + offset + 1, at, JSON.stringify(entry)]);
        });

        // An activation is open from the entry that starts it to the entry that
        // ends it. `next` reads this to keep a second one from beginning, and
        // the log is the only thing that knows — so it is derived from the log
        // rather than asserted by a caller.
        const opens = entries.some((entry) => entry.type === "run.started");
        const closes = entries.some((entry) => entry.type === "run.finished");
        // Only a write that records work renews the claim. Renewing on any
        // append at all meant a message *to* a session renewed the claim of the
        // worker that was supposed to read it — so a dead worker's session
        // stayed claimed for as long as anyone kept talking to it, invisible to
        // `next` (the claim never lapsed) and to `interrupted` (the queue was not
        // empty). An activation renews by doing its work, and being spoken to
        // is not its work.
        const worked = entries.length > 0;
        // Every write by an open activation renews its claim. Without this the
        // timestamp stayed at whenever the run began, so any turn outstanding
        // longer than the claim window was handed to a second worker while it
        // was still going — and a compare-and-swap cannot un-run a tool call.
        // A worker that dies still releases, because a dead worker stops writing.
        const runningSince = closes ? null : (opens || (worked && session.running_since)) ? at : session.running_since;

        const merged = metadata
          ? JSON.stringify({ ...(JSON.parse(session.metadata) as object), ...(metadata as object) })
          : session.metadata;
        const waiting = queueOf(session);
        if (takePending !== undefined && takePending > waiting.length) {
          // The one loss this design exists to prevent, reachable from a
          // caller's off-by-one: silently dropping messages nothing recorded.
          // `takePending` is only ever `claim.pending.length`, so a larger
          // number means the caller is working from a queue that is not there.
          database.exec("ROLLBACK");
          return err<StoreError>({
            code: "conflict",
            message: `Asked to take ${takePending} deliveries from a queue of ${waiting.length}`,
            retryable: false,
          });
        }
        const queue = takePending ? waiting.slice(takePending) : waiting;
        /** Which sessions this write put input on, this one included. */
        const delivered = new Set<string>();
        run(
          `UPDATE sessions SET last_seq = ?, metadata = ?, pending = ?, running_since = ?, updated_at = ?
            WHERE id = ?`,
          [expectedSeq + entries.length, merged, JSON.stringify(queue), runningSince, at, sessionId],
        );

        // Swept before the ids are checked, not after: an id past its window is
        // forgotten, and one still inside it is not. Sweeping afterwards left
        // every expired id alive for exactly one more send.
        run(`DELETE FROM deliveries WHERE at < ?`,
          [new Date(Date.parse(at) - deliveryMemoryMs).toISOString()]);

        for (const delivery of enqueue ?? []) {
          const target = one<{ pending: string }>(`SELECT pending FROM sessions WHERE id = ?`, [delivery.sessionId]);
          if (!target) { database.exec("ROLLBACK"); return err(notFound(delivery.sessionId)); }

          // Two deliveries with the same id from the same sender are the same
          // delivery, and stay so after the first has been read — the whole
          // point of an idempotency key is that it survives the queue. The
          // sender is part of it because the id is the sender's own: without
          // that, two agents numbering their messages from one silently
          // suppress each other.
          // The column is one string, so the two fields are joined into one
          // here. The encoding is this adapter's own and never leaves it: no
          // caller reads the column, and a store that keys the same fact some
          // other way is answering the same question, which is the one the
          // conformance suite asks.
          if (delivery.id) {
            const sender = delivery.from ? `${delivery.from.kind}:${delivery.from.id}` : "";
            const seen = one<{ delivery_id: string }>(
              `SELECT delivery_id FROM deliveries WHERE session_id = ? AND sender = ? AND delivery_id = ?`,
              [delivery.sessionId, sender, delivery.id]);
            if (seen) continue;
            run(`INSERT INTO deliveries (session_id, sender, delivery_id, at) VALUES (?, ?, ?, ?)`,
              [delivery.sessionId, sender, delivery.id, at]);
          }

          run(`UPDATE sessions SET pending = ?, updated_at = ? WHERE id = ?`,
            [JSON.stringify([...queueOf(target), delivery]), at, delivery.sessionId]);
          delivered.add(delivery.sessionId);
        }
        database.exec("COMMIT");
        // After the commit, never before: a watcher that looked on an earlier
        // wake would find nothing and never be told again.
        woke([
          { sessionId, runnable: delivered.has(sessionId) || queue.length > 0 },
          ...[...delivered].filter((id) => id !== sessionId).map((id) => ({ sessionId: id, runnable: true })),
        ]);
        return ok({ seq: expectedSeq + entries.length });
      } catch (error) {
        database.exec("ROLLBACK");
        return err(failed(error));
      }
    },

    async list({ key, limit = 50, before }) {
      try {
      // The cursor carries the id as well as the timestamp, because sessions
      // written in the same tick have no order without it — and a plain
      // `< before` then steps over every row that shares the boundary instant.
      const [beforeAt, beforeId] = before ? splitCursor(before) : [null, null];
      const rows = database.query(
        `SELECT * FROM sessions
          WHERE (? IS NULL OR key = ?)
            AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
          ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ).all(key ?? null, key ?? null, beforeAt, beforeAt, beforeAt, beforeId, limit) as SessionRow[];
      return ok(rows.map((row): SessionSummary => ({
        sessionId: row.id,
        agent: { id: row.agent_id, version: row.agent_ver },
        key: row.key,
        seq: row.last_seq,
        metadata: JSON.parse(row.metadata) as JsonValue,
        updatedAt: row.updated_at,
      })));
      } catch (error) { return err(failed(error)); }
    },

    /**
     * Claim a session that has input and no activation already running.
     *
     * The queue is reported and left in place; the append that commits it as
     * entries is what removes it. Nothing here is destructive, so a worker that
     * takes this and then dies costs one expired claim and no messages.
     */
    async next({ signal }) {
      // Nothing is owed to a caller that has given up. Answered rather than
      // refused: "nothing to claim" is true, and it needs no code of its own.
      if (signal?.aborted) return ok(undefined);
      const now = Date.now();
      const stale = new Date(now - claimMs).toISOString();
      try {
        database.exec("BEGIN IMMEDIATE");
        const row = one<SessionRow>(
          `SELECT * FROM sessions
            WHERE pending <> '[]' AND (running_since IS NULL OR running_since < ?)
            ORDER BY updated_at LIMIT 1`, [stale]);
        if (!row) { database.exec("COMMIT"); return ok(undefined); }
        run(`UPDATE sessions SET running_since = ? WHERE id = ?`, [new Date(now).toISOString(), row.id]);
        database.exec("COMMIT");
        return ok<Runnable>({
          sessionId: row.id,
          seq: row.last_seq,
          pending: queueOf(row),
          metadata: JSON.parse(row.metadata) as JsonValue,
        });
      } catch (error) {
        database.exec("ROLLBACK");
        return err(failed(error));
      }
    },

    /**
     * Claim a session whose activation was interrupted.
     *
     * The mirror of `next`, over the two columns that already exist: an open
     * run — `running_since` set, because the entry that would clear it never
     * committed — whose claim has lapsed, and an empty queue, because the
     * commit that opened the run took what made it runnable. Nothing else in
     * the store can see this session, which is why the port asks for it here
     * rather than leaving every application to write this query itself.
     */
    async interrupted({ signal }) {
      if (signal?.aborted) return ok(undefined);
      const now = Date.now();
      const stale = new Date(now - claimMs).toISOString();
      try {
        database.exec("BEGIN IMMEDIATE");
        const row = one<SessionRow>(
          `SELECT * FROM sessions
            WHERE pending = '[]' AND running_since IS NOT NULL AND running_since < ?
            ORDER BY updated_at LIMIT 1`, [stale]);
        if (!row) { database.exec("COMMIT"); return ok(undefined); }
        run(`UPDATE sessions SET running_since = ? WHERE id = ?`, [new Date(now).toISOString(), row.id]);
        database.exec("COMMIT");
        return ok<Runnable>({
          sessionId: row.id,
          seq: row.last_seq,
          pending: [],
          metadata: JSON.parse(row.metadata) as JsonValue,
        });
      } catch (error) {
        database.exec("ROLLBACK");
        return err(failed(error));
      }
    },

    /**
     * The feed is this store's own writes, and reaches exactly as far as they
     * do: a watcher here is woken by what this instance commits, and by nothing
     * else. Another process on the same file, a second store over the same
     * handle, and the application's own SQL beside the log are all invisible,
     * because sqlite has no channel to tell us — that is the miss the port
     * requires a heartbeat for. The case that matters is covered: the surface
     * that writes a delivery and the worker that reads it are the same process,
     * and usually the same store.
     */
    watch(watcher) {
      watchers.add(watcher);
      return () => { watchers.delete(watcher); };
    },

    async close() { watchers.clear(); /* the caller owns the handle it passed in */ },
  };
}
