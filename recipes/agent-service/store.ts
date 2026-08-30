/**
 * A PostgreSQL store, written entirely from the public contract.
 *
 * It lives in this recipe rather than in the package because the package
 * depends only on `zod`. That constraint turns into the strongest proof the
 * library can offer: a store adapter built from nothing but the `Store`
 * interface. Copy this file to start your own.
 */
import type {
  Store, StoreChange, StoreConflict, StoreError, SessionRead, SessionSummary, Runnable,
} from "aglib/store";
import type { Delivery, Entry, Stored } from "aglib/session";
import type { JsonValue } from "aglib";
import { err, ok } from "aglib";
import { SQL } from "bun";
import pg from "pg";

/**
 * Three tables. `entries` is the log; `sessions` carries identity, the opaque
 * key an application indexes by, its metadata, and the pending inputs that make
 * a session runnable; `deliveries` remembers the ids that have been seen, which
 * has to outlive the queue because the common case is a duplicate arriving
 * after the first copy was already read.
 */
export const schema = `
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    agent_ver   TEXT NOT NULL,
    key         TEXT,
    metadata    JSONB NOT NULL DEFAULT '{}',
    pending     JSONB NOT NULL DEFAULT '[]',
    last_seq      INTEGER NOT NULL DEFAULT 0,
    running_since TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', now())
  );
  CREATE TABLE IF NOT EXISTS entries (
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    seq         INTEGER NOT NULL,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    body        JSONB NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    session_id  TEXT NOT NULL,
    sender      TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, sender, delivery_id)
  );
  CREATE INDEX IF NOT EXISTS sessions_by_key ON sessions (key, updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS sessions_runnable ON sessions (updated_at) WHERE pending <> '[]';
  DROP INDEX IF EXISTS sessions_stranded; -- sessions_interrupted under its former name
  CREATE INDEX IF NOT EXISTS sessions_interrupted ON sessions (updated_at) WHERE running_since IS NOT NULL;
  CREATE INDEX IF NOT EXISTS deliveries_by_age ON deliveries (at);
`;

/**
 * Every JSON parameter below goes in as `::text::jsonb`, never `::jsonb`.
 *
 * The driver encodes the parameter as JSON itself, so a bare `::jsonb` cast
 * receives a quoted string and stores a jsonb *string* rather than the
 * document: everything downstream then reads it character by character, and
 * `||` on two of them builds an array instead of merging. `::text` is what
 * makes the cast see what was written.
 */
interface SessionRow {
  id: string; agent_id: string; agent_ver: string; key: string | null;
  metadata: JsonValue; pending: Delivery[]; last_seq: number; running_since: Date | null; updated_at: Date;
}

const DEFAULT_CLAIM_MS = 10 * 60 * 1000;
const DEFAULT_DELIVERY_MEMORY_MS = 7 * 24 * 60 * 60 * 1000;

/** One channel for the whole database; the payload says which session moved. */
const CHANGES = "aglib_session_changed";

/**
 * A refusal raised from inside a transaction, so it rolls back.
 *
 * Returning a failed `Result` from `sql.begin` commits: the callback resolved,
 * so the driver committed, and a delivery to a session that does not exist left
 * the sender's own entries behind. Throwing is how a caller says no here.
 */
class Refused extends Error {
  constructor(readonly failure: StoreError | StoreConflict) { super(failure.message); }
}

export async function createPostgresStore(input: {
  url: string;
  claimMs?: number;
  /** How long a delivery id is remembered. Defaults to seven days. */
  deliveryMemoryMs?: number;
  /**
   * Where the change feed listens, when that is not `url`.
   *
   * `LISTEN` is a property of a session, so it needs a connection that is held
   * rather than borrowed — which means the direct endpoint, never a transaction
   * pooler. A pooler hands the next statement to whichever backend is free, and
   * a `LISTEN` registered on one is not held by the next.
   */
  listenerUrl?: string;
}): Promise<Store> {
  const sql = new SQL(input.url);
  const claimMs = input.claimMs ?? DEFAULT_CLAIM_MS;
  const deliveryMemoryMs = input.deliveryMemoryMs ?? DEFAULT_DELIVERY_MEMORY_MS;
  // A claim is written with `now()` and must be read against `now()`. Comparing
  // a server timestamp with one this process computed makes the window as wide
  // as the clock skew between them, which on a database in a container was
  // enough to hand a claimed session straight back out.
  const lapse = `${claimMs} milliseconds`;
  await sql.unsafe(schema);

  const notFound = (sessionId: string): StoreError =>
    ({ code: "not-found", message: `No session ${sessionId}`, retryable: false });
  const failed = (error: unknown): StoreError =>
    ({ code: "failed", message: error instanceof Error ? error.message : String(error), retryable: false });

  const watchers = new Set<(change: StoreChange) => void>();
  let listening: Promise<pg.Client> | undefined;


  /**
   * Wake this process's watchers.
   *
   * Called from the write itself as well as from `LISTEN`, deliberately. The
   * notification is how another process finds out; this is how *this* one does,
   * and it keeps working when the listening connection is down. A local watcher
   * is therefore usually woken twice, which the port allows — a wake is a
   * request to look — and which costs one repeated query. Suppressing the echo
   * to avoid that is what an earlier implementation did, and it cost a delivery
   * written by the HTTP surface waking the worker beside it not at all.
   */
  const woke = (changes: readonly StoreChange[]): void => {
    if (!watchers.size || !changes.length) return;
    for (const watcher of [...watchers]) {
      queueMicrotask(() => {
        if (!watchers.has(watcher)) return;
        for (const change of changes) watcher(change);
      });
    }
  };

  return {
    async create({ sessionId, agent, key, metadata }) {
      try {
        await sql`
          INSERT INTO sessions (id, agent_id, agent_ver, key, metadata)
          VALUES (${sessionId}, ${agent.id}, ${agent.version}, ${key ?? null}, ${JSON.stringify(metadata ?? {})}::text::jsonb)
          ON CONFLICT (id) DO NOTHING`;
        woke([{ sessionId, runnable: false }]);
        return ok(undefined);
      } catch (error) { return err(failed(error)); }
    },

    async read({ sessionId, afterSeq = 0 }) {
      try {
        const [session] = await sql`SELECT * FROM sessions WHERE id = ${sessionId}` as SessionRow[];
        if (!session) return err(notFound(sessionId));
        const rows = await sql`
          SELECT seq, at, body FROM entries
           WHERE session_id = ${sessionId} AND seq > ${afterSeq} ORDER BY seq` as
          { seq: number; at: Date; body: Entry }[];
        return ok<SessionRead>({
          sessionId,
          agent: { id: session.agent_id, version: session.agent_ver },
          seq: session.last_seq,
          metadata: session.metadata,
          entries: rows.map((row): Stored => ({ ...row.body, seq: row.seq, at: row.at.toISOString() })),
          pending: session.pending,
        });
      } catch (error) { return err(failed(error)); }
    },

    /**
     * The one operation that makes orchestration safe: this session's entries,
     * the inputs it delivers to other sessions, and the queue it consumed all
     * commit together, or not at all.
     */
    async append({ sessionId, expectedSeq, entries, enqueue, metadata, takePending }) {
      try {
        // The wakes come back out of the transaction rather than being sent
        // from inside it: a watcher told about a change it cannot yet read
        // would look, find nothing, and never be told again.
        const { written, changed } = await sql.begin(async (tx) => {
          // An activation is open from the entry that starts it to the entry
          // that ends it, and the queue is consumed by the write that commits
          // it — so a caller that loses this compare-and-swap destroys nothing.
          const opens = entries.some((entry) => entry.type === "run.started");
          const closes = entries.some((entry) => entry.type === "run.finished");
          const advanced = await tx`
            UPDATE sessions SET last_seq = last_seq + ${entries.length}, updated_at = date_trunc('milliseconds', now()),
                   metadata = metadata || ${JSON.stringify(metadata ?? {})}::text::jsonb,
                   -- Every write an open activation makes renews its claim.
                   -- Holding the instant the run began handed any turn longer
                   -- than the window to a second worker while the first was
                   -- still going, and a compare-and-swap can refuse a write
                   -- but cannot un-run a tool call.
                   -- Only a write that records work renews. Renewing on any
                   -- append meant a message TO a session renewed the claim of
                   -- the worker meant to read it, so a dead worker session
                   -- stayed invisible to both questions for as long as anyone
                   -- kept talking to it.
                   running_since = CASE WHEN ${closes} THEN NULL
                                        WHEN ${opens} THEN date_trunc('milliseconds', now())
                                        WHEN ${entries.length > 0} AND running_since IS NOT NULL
                                          THEN date_trunc('milliseconds', now())
                                        ELSE running_since END
             WHERE id = ${sessionId} AND last_seq = ${expectedSeq}
             RETURNING last_seq` as { last_seq: number }[];
          if (!advanced.length) {
            const [current] = await tx`SELECT last_seq FROM sessions WHERE id = ${sessionId}` as { last_seq: number }[];
            if (!current) throw new Refused(notFound(sessionId));
            throw new Refused({
              code: "conflict", message: `Session moved to ${current.last_seq}`,
              retryable: true, actualSeq: current.last_seq,
            } satisfies StoreConflict);
          }
          for (const [offset, entry] of entries.entries()) {
            await tx`INSERT INTO entries (session_id, seq, body)
                     VALUES (${sessionId}, ${expectedSeq + offset + 1}, ${JSON.stringify(entry)}::text::jsonb)`;
          }
          // Swept before the ids are checked, not after: an id past its window
          // is forgotten, and one still inside it is not.
          await tx`DELETE FROM deliveries WHERE at < now() - ${`${deliveryMemoryMs} milliseconds`}::interval`;
          if (takePending !== undefined) {
            const [held] = await tx`
              SELECT jsonb_array_length(pending) AS waiting FROM sessions WHERE id = ${sessionId}
            ` as { waiting: number }[];
            if (takePending > (held?.waiting ?? 0)) {
              // Silently dropping messages nothing recorded is the one loss
              // this design exists to prevent, and a caller's off-by-one
              // reaches it. `takePending` is only ever `claim.pending.length`.
              throw new Refused({
                code: "conflict",
                message: `Asked to take ${takePending} deliveries from a queue of ${held?.waiting ?? 0}`,
                retryable: false,
                actualSeq: advanced[0]!.last_seq,
              } satisfies StoreConflict);
            }
          }
          // Written as a slice rather than in the UPDATE above, because
          // `jsonb` has no ergonomic "drop the first n" and clarity beats one
          // fewer statement here.
          if (takePending) {
            await tx`
              UPDATE sessions
                 SET pending = COALESCE((
                       SELECT jsonb_agg(value ORDER BY ordinality)
                         FROM jsonb_array_elements(pending) WITH ORDINALITY
                        WHERE ordinality > ${takePending}), '[]'::jsonb)
               WHERE id = ${sessionId}`;
          }
          /** Which sessions this write put input on, this one included. */
          const landed = new Set<string>();
          for (const delivery of enqueue ?? []) {
            // An id means "this delivery, once", and it has to hold after the
            // first copy has been read — so it is remembered in a table rather
            // than inferred from what is still queued. The sender is part of
            // the key because the id is the sender's own: without that, two
            // agents numbering their messages from one suppress each other.
            if (delivery.id) {
              const sender = delivery.from ? `${delivery.from.kind}:${delivery.from.id}` : "";
              const first = await tx`
                INSERT INTO deliveries (session_id, sender, delivery_id)
                VALUES (${delivery.sessionId}, ${sender}, ${delivery.id})
                ON CONFLICT DO NOTHING RETURNING delivery_id` as { delivery_id: string }[];
              if (!first.length) {
                // Seen before, so nothing is queued — but a delivery addressed
                // to a session that does not exist is still not-found, and the
                // insert above cannot tell the caller that.
                const [exists] = await tx`SELECT id FROM sessions WHERE id = ${delivery.sessionId}` as { id: string }[];
                if (!exists) throw new Refused(notFound(delivery.sessionId));
                continue;
              }
            }
            const delivered = await tx`
              UPDATE sessions
                 SET pending = pending || ${JSON.stringify([delivery])}::text::jsonb,
                     updated_at = date_trunc('milliseconds', now())
               WHERE id = ${delivery.sessionId} RETURNING id` as { id: string }[];
            if (!delivered.length) throw new Refused(notFound(delivery.sessionId));
            landed.add(delivery.sessionId);
          }
          // Read back rather than inferred: `takePending` and a delivery to
          // this session both move the queue, and what a watcher is told has to
          // be what the row now says.
          const [row] = await tx`
            SELECT pending FROM sessions WHERE id = ${sessionId}` as { pending: unknown[] }[];
          const changed: readonly StoreChange[] = [
            { sessionId, runnable: landed.has(sessionId) || (row?.pending.length ?? 0) > 0 },
            ...[...landed].filter((id) => id !== sessionId).map((id) => ({ sessionId: id, runnable: true })),
          ];
          // Inside the transaction, so Postgres holds each notification until
          // the commit and releases it in order: a listener is never woken
          // about a change it cannot yet read.
          for (const change of changed) await tx`SELECT pg_notify(${CHANGES}, ${JSON.stringify(change)})`;
          return { written: ok({ seq: advanced[0]!.last_seq }), changed };
        });
        woke(changed);
        return written;
      } catch (error) {
        return err(error instanceof Refused ? error.failure : failed(error));
      }
    },

    async list({ key, limit = 50, before }) {
      try {
        // The cursor carries the id as well as the instant, because sessions
        // written in the same tick have no order without it — and a plain
        // `< before` then steps over every row sharing the boundary.
        //
        // `updated_at` is stored truncated to milliseconds for the same reason:
        // a cursor is an ISO 8601 string, which carries milliseconds and not
        // the microseconds `now()` produces. Stored at full precision the
        // equality branch below never matches, so the id tie-break is dead
        // code and the boundary it was written for is stepped over anyway.
        const cut = before ? before.lastIndexOf("|") : -1;
        const beforeAt = before ? (cut < 0 ? before : before.slice(0, cut)) : null;
        const beforeId = before && cut >= 0 ? before.slice(cut + 1) : "";
        const rows = await sql`
          SELECT * FROM sessions
           WHERE (${key ?? null}::text IS NULL OR key = ${key ?? null})
             AND (${beforeAt}::timestamptz IS NULL
                  OR updated_at < ${beforeAt}::timestamptz
                  OR (updated_at = ${beforeAt}::timestamptz AND id < ${beforeId}))
           ORDER BY updated_at DESC, id DESC LIMIT ${limit}` as SessionRow[];
        return ok(rows.map((row): SessionSummary => ({
          sessionId: row.id,
          agent: { id: row.agent_id, version: row.agent_ver },
          key: row.key,
          seq: row.last_seq,
          metadata: row.metadata,
          updatedAt: row.updated_at.toISOString(),
        })));
      } catch (error) { return err(failed(error)); }
    },

    /**
     * Take the next session with unprocessed input and clear its queue into the
     * caller's hands. `SKIP LOCKED` keeps workers off each other's toes; it is
     * an efficiency, not a correctness mechanism — `append` is what makes the
     * work safe.
     */
    async next() {
      try {
        return await sql.begin(async (tx) => {
          const [row] = await tx`
            SELECT * FROM sessions
             WHERE pending <> '[]' AND (running_since IS NULL OR running_since < now() - ${lapse}::interval)
             ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED` as SessionRow[];
          if (!row) return ok(undefined);
          // Claimed, not consumed. `SKIP LOCKED` keeps workers off each other
          // inside this transaction; the claim keeps a second activation from
          // starting after it; the compare-and-swap in `append` is what makes
          // either of those safe to be wrong about.
          await tx`UPDATE sessions SET running_since = now() WHERE id = ${row.id}`;
          return ok<Runnable>({
            sessionId: row.id, seq: row.last_seq, pending: row.pending, metadata: row.metadata,
          });
        });
      } catch (error) { return err(failed(error)); }
    },

    /**
     * The other question a worker asks: what was being worked when a process
     * stopped existing. `next` cannot see it — the session is open, and the
     * queue that made it runnable was consumed by the commit that recorded it.
     */
    async interrupted() {
      try {
        return await sql.begin(async (tx) => {
          const [row] = await tx`
            SELECT * FROM sessions
             WHERE pending = '[]'::jsonb
               AND running_since IS NOT NULL AND running_since < now() - ${lapse}::interval
             ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED` as SessionRow[];
          if (!row) return ok(undefined);
          await tx`UPDATE sessions SET running_since = now() WHERE id = ${row.id}`;
          return ok<Runnable>({ sessionId: row.id, seq: row.last_seq, pending: [], metadata: row.metadata });
        });
      } catch (error) { return err(failed(error)); }
    },

    /**
     * A held connection running `LISTEN`, opened with the first watcher and
     * released with the last, so a store nobody is watching costs nothing.
     *
     * Its own driver, because Bun's `SQL` carries no notification channel at
     * 1.3.14 — checked at runtime, not read off the types, which are ahead of
     * it. A dropped connection drops the feed and the next `watch` reopens it;
     * what covers the gap is the caller's heartbeat, which the port requires
     * precisely because no feed promises delivery.
     */
    watch(watcher) {
      watchers.add(watcher);
      listening ??= (async () => {
        const client = new pg.Client({ connectionString: input.listenerUrl ?? input.url });
        client.on("notification", (message) => {
          if (message.channel !== CHANGES || !message.payload) return;
          try { woke([JSON.parse(message.payload) as StoreChange]); }
          catch { /* a payload this store did not write */ }
        });
        // A feed that falls over is a feed that is not there. Dropped rather
        // than retried in a loop: the next watcher opens a new one, and until
        // then the heartbeat is what carries every worker.
        client.on("error", () => { listening = undefined; void client.end().catch(() => {}); });
        await client.connect();
        await client.query(`LISTEN ${CHANGES}`);
        return client;
      })();
      void listening.catch(() => { listening = undefined; });

      return () => {
        watchers.delete(watcher);
        if (watchers.size) return;
        const held = listening;
        listening = undefined;
        void held?.then((client) => client.end()).catch(() => {});
      };
    },

    async close() {
      watchers.clear();
      const held = listening;
      listening = undefined;
      await held?.then((client) => client.end()).catch(() => {});
      await sql.end();
    },
  };
}
