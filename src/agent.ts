import type { Content } from "./content.js";
import type { Harness } from "./harness/harness.js";
import type { Decide, Tool } from "./tools/tool.js";
import type { Delivery, Runnable, Store } from "./store/store.js";
import type { Update } from "./harness/harness.js";
import type { Failure } from "./result.js";
import type { From, Usage } from "./session/entry.js";

/** An inert declaration. Nothing here opens a connection or holds state. */
export interface Agent {
  id: string;
  /** Bump when instructions, tools or configuration stop being compatible with an existing session. */
  version: string;
  instructions: Content;
  harness: Harness;
  tools?: readonly Tool[];
  /** Per-call policy over parsed arguments. Absent means every call executes. */
  decide?: Decide;
  /** Runs once as an activation ends, whatever ended it; its deliveries commit with the final entries. */
  finished?(run: {
    sessionId: string; runId: string;
    outcome: "completed" | "failed" | "cancelled";
    output: Content;
  }): readonly Delivery[] | Promise<readonly Delivery[]>;
  /**
   * Ceilings on one activation, over the facts this library holds: turns and
   * tool calls are on the log, and a deadline is the clock.
   *
   * There is no ceiling on money, and the asymmetry is the point. A spend limit
   * would have to read a rate table the library does not have and should not
   * carry, so it would take a function from the caller and then need defending
   * against it — a code for "you declared a ceiling nothing can hold", a rule
   * for a generation the function could not price, a check for a price that is
   * negative or not a number. All of that is the cost of enforcing something
   * from a fact we do not own, and enforcing it is policy besides: the two
   * applications that wanted one wanted it to stop at different moments.
   *
   * `RunResult.usage` is what a caller needs from here, and it is solid. What
   * that costs, and what to do about it, is priced by whoever holds the rates.
   */
  limits?: { maxTurns?: number; maxToolCalls?: number; deadline?: string };
}

/**
 * How an activation ended, and what it consumed on the way.
 *
 * `usage` is on every outcome, not only a completed one: a run that burned four
 * dollars of tokens and then failed burned them, and a caller that has to ask
 * the log to find that out has been handed a result missing the expensive half
 * of what happened.
 *
 * Summed from the `assistant` entries this activation committed, which is why a
 * harness does not report it — the log already holds every generation, and a
 * second total is a second answer. Money is not here: the counts are the fact,
 * and the rates that turn them into money belong to the deployment.
 */
export type RunResult =
  | { status: "completed"; output: Content; usage: Usage; seq: number }
  | { status: "cancelled"; usage: Usage; seq: number }
  | { status: "failed"; error: Failure; usage: Usage; seq: number };

export interface AgentRun extends AsyncIterable<Update> {
  readonly result: Promise<RunResult>;
  cancel(): void;
}

/**
 * One piece of input for an activation, and where it came from.
 *
 * Always the object form, because `Content` may itself be an array of parts and
 * a bare array therefore cannot say whether it is one multi-part message or
 * several messages. `RunAgentOptions.input` still takes plain content for the
 * common case; only the *many* form is required to name each arrival.
 */
export interface Arrival { input: Content; from?: From }

interface RunAgentBase {
  agent: Agent;
  /** Opaque application index key, used only when this run creates the session. */
  key?: string;
  context?: { run?: string; turn?: string };
  signal?: AbortSignal;
}

/**
 * An activation is working one of two things, and never both.
 *
 * A caller is **sending** — a person typed, a webhook fired, a test asked a
 * question. Or a worker is running **what the store handed it**, which carries
 * the session, the position to write from, and the deliveries to consume, all
 * as one value that arrived together and cannot be recombined wrongly.
 *
 * That second form replaced three fields a worker had to line up by hand:
 * `sessionId`, the position, and how many deliveries to take. Every one of them
 * was only ever a field of the claim, so each was a value another field already
 * determined — and the one that mattered, taking the deliveries, silently
 * left the input queued for ever when it was forgotten. Both applications
 * written on this wrote the same eight lines to get it right.
 */
export type RunAgentOptions = RunAgentBase & (
  | {
      /** One message as plain content, one named arrival, or several named arrivals. */
      input: Content | Arrival | readonly Arrival[];
      /**
       * Which session it goes to, as a UUID. A new one is opened when this is
       * omitted. An application's own naming for a conversation goes in `key`,
       * which is opaque to the library; a store is entitled to keep a session
       * id in a `uuid` column and refuse anything else.
       */
      sessionId?: string;
      /** Omit for an ephemeral run: the log lives in memory and nothing is persisted. */
      store?: Store;
      claim?: never;
    }
  | {
      /**
       * What `store.next()` or `store.interrupted()` handed this worker.
       *
       * Its deliveries become this activation's input and are consumed by the
       * write that commits them, in the same compare-and-swap that checks the
       * position — so a worker that loses the race loses its turn and never the
       * messages. A claim with an empty queue is a **resumption**: nothing opens
       * it, the loop continues the committed log, and the effect that already
       * happened is read there rather than asked for again. Only a harness
       * declaring `recovery: "history"` is given one.
       */
      claim: Runnable;
      /**
       * Required here, unlike a caller sending. A claim is a position in a log
       * and a queue to consume, and both of those are the store's — without one
       * the deliveries would be replayed into memory and left queued for ever.
       */
      store: Store;
      /**
       * Something the worker is adding of its own, ahead of what was waiting.
       *
       * One real use: orientation for a harness whose protocol has no system
       * prompt, which has nowhere else to go and must lead. Adding nothing is
       * the ordinary case.
       */
      input?: Content | Arrival | readonly Arrival[];
      sessionId?: never;
    }
);
