import type { Entry, Stored } from "./entry.js";

/**
 * The session's state: ordered entries and the position of the last one.
 *
 * Not a record of state kept somewhere else — this is what the loop reads to
 * build its next request and what it appends its results to. A store persists
 * it; without one it lives here and the session is ephemeral.
 */
export interface Log {
  readonly seq: number;
  readonly entries: readonly Stored[];
  /** Stamps and appends, returning what was added. */
  append(entries: readonly Entry[]): readonly Stored[];
}

/**
 * `at` is the session's real position, which is the store's to say. Deriving it
 * from the last entry is a second answer to the same question, and the two
 * agree only while nothing has ever been read from a cursor.
 */
export function createLog(initial: readonly Stored[] = [], at = initial.at(-1)?.seq ?? 0): Log {
  const entries: Stored[] = [...initial];
  let seq = at;
  return {
    get seq() { return seq; },
    // A copy. `entries()` on a harness context is documented beside `history()`,
    // which is rebuilt every call precisely so a harness cannot hold something
    // that drifts from the log; handing out the live array made one of the pair
    // a lie.
    get entries(): readonly Stored[] { return [...entries]; },
    append(added) {
      const at = new Date().toISOString();
      const stamped = added.map((entry): Stored => ({ ...entry, seq: (seq += 1), at }));
      entries.push(...stamped);
      return stamped;
    },
  };
}
