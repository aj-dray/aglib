import type { Content } from "../content.js";
import type { Delivery, Entry, Stored, Usage } from "../session/entry.js";
import type { Message, ModelResponse, ModelError } from "../model/model.js";
import type { Result } from "../result.js";
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
  | { type: "hook.error"; hook: string; message: string }
  | { type: "text.delta"; text: string; phase?: "commentary" | "final_answer"; runId?: string; generationId?: string }
  | { type: "reasoning.delta"; text: string; runId?: string; generationId?: string }
  | { type: "tool.progress"; callId: string; data: JsonValue }
  /** Arguments arriving a fragment at a time, so a viewer can show a call forming. */
  | { type: "tool-call.delta"; callId: string; arguments: string; runId?: string; generationId?: string }
  | { type: "entry"; entry: Stored };

export interface HarnessContext {
  /** The same callbacks used by the run; a harness invokes model boundaries it owns. */
  hooks?: readonly LifecycleHook[];
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
  commit(entries: readonly Entry[], deliveries?: readonly Delivery[]): Promise<void>;
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
  /** Wait until input may be available. A wake is a reason to drain, never the input itself. */
  waitForInput?(): Promise<void>;
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

/** One application extension, configured alongside other lifecycle work. */
export interface LifecycleHook {
  name: string;
  beforeRun?(context: HarnessContext): void | Promise<void>;
  beforeModel?(context: HarnessContext): void | Failure | Promise<void | Failure>;
  afterModel?(context: HarnessContext, result: Result<ModelResponse, ModelError>): void | Promise<void>;
  /** Only a completed, non-cancelled run may continue, once per hook name and run id. */
  beforeStop?(context: HarnessContext, result: HarnessResult):
    void | { input: Content } | { deliveries: readonly Delivery[] } |
    Promise<void | { input: Content } | { deliveries: readonly Delivery[] }>;
  /** After the terminal write; exceptions are observable but cannot change the outcome or skip other hooks. */
  afterRun?(context: HarnessContext, result: HarnessResult & { seq: number; usage: Usage }): void | Promise<void>;
}

/**
 * Executes one activation of an agent.
 *
 * One fact, not eight. Everything the old capability matrix carried was either
 * optional output, a different subsystem, or something no consumer asked about.
 *
 * `toolUse` went the same way, one release later. It claimed to say whose tools
 * ran — "application" through the executor, "harness" its own — and three
 * things were wrong with it. Nothing branched on it; no document owned the
 * claim; and the word did not survive contact with the adapters. A harness can
 * run a *vendor's* tools through our executor, validated and authorized, and a
 * harness can run tools *we wrote* inside its own process. Whose tools, whose
 * code and whose authority are three questions, and one enum answered none of
 * them reliably.
 *
 * The question it was reaching for — did anyone authorize this call — is a fact
 * about a call, not about a harness, and belongs on the tool entry if and when
 * something needs to read it. `recipes/vendored-agent` and
 * `docs/ARCHITECTURE.md` carry the per-adapter comparison in prose, which is
 * where a fact about adapters belongs and where it can be accurate.
 */
export interface Harness {
  readonly id: string;
  /** "history": committed entries are enough to restart. "none": an interrupted run is over. */
  readonly recovery: "history" | "none";
  run(context: HarnessContext): Promise<HarnessResult>;
}
