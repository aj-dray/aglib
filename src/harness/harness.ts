import type { Content } from "../content.js";
import type { Entry, Stored } from "../session/entry.js";
import type { Message } from "../model/model.js";
import type { ToolExecutor } from "../tools/tool.js";
import type { Failure } from "../result.js";
import type { JsonValue } from "../json.js";

/**
 * Ephemeral output for a live viewer. Only committed entries are recovery state.
 *
 * An `entry` update carries the whole `Stored` shape — sequence and commit time
 * both. Anything building a live projection off this stream needs the timestamp
 * the log already has, and inventing one at receipt would put a second answer
 * to the same question into the world.
 */
export type Update =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.progress"; callId: string; data: JsonValue }
  /** Arguments arriving a fragment at a time, so a viewer can show a call forming. */
  | { type: "tool-call.delta"; callId: string; arguments: string }
  | { type: "entry"; entry: Stored };

export interface HarnessContext {
  sessionId: string;
  runId: string;
  instructions: Content;
  /**
   * The log projected for this turn. A function, not a snapshot: it is rebuilt
   * from committed entries every time it is read, so a harness cannot hold a
   * transcript that drifts from the log.
   */
  history(): readonly Message[];
  /**
   * The committed log itself. A harness needs it to reason in sequence numbers
   * — where a compaction may cut, which call has no result yet — which the
   * projection deliberately does not carry.
   */
  entries(): readonly Stored[];
  /**
   * Application context placed around the cache boundary. `run` is stable for
   * the whole run and sits inside the cached prefix; `turn` is for this request
   * only and sits after it. Getting that split right is the loop's job because
   * only the loop knows where the prefix ends.
   */
  context?: { run?: string; turn?: string };
  tools?: ToolExecutor;
  /**
   * Commit to the log. Returns when durable — a harness never holds
   * uncommitted state.
   *
   * A refused write **rejects**, and a harness must not catch it: a lost
   * compare-and-swap means another writer is at this position, and the run is
   * over. Anything the agent was sending with that write goes with it.
   */
  commit(entries: readonly Entry[]): Promise<void>;
  /**
   * Fold any waiting input into this activation, and say how much arrived.
   *
   * Called at a boundary the harness picks — ours takes it after each batch of
   * tool results, which is the last point at which nothing is half-done. This
   * is the whole of `priority: "turn"`: a message reaching a busy session
   * without the turn's work being thrown away to get its attention.
   *
   * A harness with no such point does not offer this, and a `"turn"` delivery
   * to it waits for the next activation instead. It is never promoted to
   * ending the one that is running — the sender asked for the place that costs
   * nothing, and the answer to "I cannot" is later, not more destructive.
   *
   * Absent when there is no store, because then nothing can be waiting.
   *
   * Two things it will not do. It folds nothing into an activation that has
   * been cancelled — a message taken off the queue by a run that is ending is a
   * message nobody answers and nothing can find again. And a store it cannot
   * read answers zero, the same as an empty queue: the failure is not hidden
   * for long, because the next commit meets it.
   */
  drain?(): Promise<number>;
  emit(update: Update): void;
  signal: AbortSignal;
}

/**
 * How one activation ended, and nothing about what it consumed.
 *
 * A harness used to report usage too, and that was a second answer to a
 * question the log already answers: every generation's counts are on the
 * `assistant` entry that carried it. `runAgent` sums those, so accounting is
 * the same fact for a harness that owns its own loop as for ours, and a
 * cancelled or failed activation still says what it spent.
 */
export type HarnessResult =
  | { status: "completed"; output: Content }
  | { status: "cancelled" }
  | { status: "failed"; error: Failure };

/**
 * Executes one activation of an agent.
 *
 * Two facts, not eight. Everything the old capability matrix carried was either
 * optional output, a different subsystem, or something no consumer asked about:
 * a caller only ever needs to know whose tools run, and whether an unfinished
 * activation can restart from the log.
 */
export interface Harness {
  readonly id: string;
  /** "application": through the executor, validated and authorized. "harness": its own, which we never claim to have authorized. */
  readonly toolUse: "application" | "harness" | "none";
  /** "history": committed entries are enough to restart. "none": an interrupted run is over. */
  readonly recovery: "history" | "none";
  run(context: HarnessContext): Promise<HarnessResult>;
}
